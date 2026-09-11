// PWD quote-form proxy.
//
// The browser posts here instead of straight to Formspree. This function
// verifies the Cloudflare Turnstile token server-side and only then forwards
// the submission on. Bots that scrape the page find this endpoint, not the
// Formspree one, and cannot pass without a real token.
//
// Env: TURNSTILE_SECRET (required), FORMSPREE_ENDPOINT (optional override).

const FORMSPREE_DEFAULT = 'https://formspree.io/f/mjybeoad';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function verifyTurnstile(token, secret, ip) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const t = withTimeout(UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: t.signal });
    if (!r.ok) return { ok: false, reason: 'verify_unavailable' };
    const d = await r.json();
    if (d.success) return { ok: true };
    // "timeout-or-duplicate" means the token was already spent or expired -
    // worth telling the customer to try again rather than failing silently.
    const codes = d['error-codes'] || [];
    return { ok: false, reason: codes.includes('timeout-or-duplicate') ? 'expired' : 'failed' };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'verify_timeout' : 'verify_error' };
  } finally {
    t.done();
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.TURNSTILE_SECRET) {
    // Fail open rather than lose a real enquiry to a misconfiguration.
    // The page still works; it just is not protected until the var is set.
    console.warn('TURNSTILE_SECRET is not set - forwarding without verification');
  }

  // Turnstile needs JavaScript, so a no-JS browser cannot get a token and
  // will post the form natively as urlencoded. Answer that in HTML rather
  // than dumping JSON at the customer.
  const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ctype.includes('application/json')) {
    return new Response(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Enable JavaScript | Premium Wine Delivery</title>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:system-ui,sans-serif;background:#F8F3EA;color:#2A121A;' +
      'margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:32px}' +
      'div{max-width:520px}h1{color:#6A1B2D;font-size:24px;margin:0 0 12px}' +
      'a{color:#6A1B2D;font-weight:600}</style></head><body><div>' +
      '<h1>We could not send that quote request</h1>' +
      '<p>The form needs JavaScript enabled to complete its spam check. ' +
      'Please enable it and try again, or email ' +
      '<a href="mailto:info@premiumwinedelivery.com">info@premiumwinedelivery.com</a> ' +
      'or call <a href="tel:+12145602501">(214) 560-2501</a> and we will take the details directly.</p>' +
      '<p><a href="/request-a-quote/">Back to the quote form</a></p>' +
      '</div></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_request', message: 'Could not read the form.' }, 400);
  }

  const token = payload['cf-turnstile-response'];
  delete payload['cf-turnstile-response'];

  if (env.TURNSTILE_SECRET) {
    if (!token) {
      return json({
        error: 'no_token',
        message: 'Please complete the verification check and try again.',
      }, 400);
    }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const v = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
    if (!v.ok) {
      const expired = v.reason === 'expired';
      return json({
        error: v.reason,
        message: expired
          ? 'That verification expired. Please try sending again.'
          : 'We could not verify this submission. Please try again, or email info@premiumwinedelivery.com.',
      }, expired ? 400 : 403);
    }
  }

  // minimum viable enquiry: we must be able to reply to it
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email))) {
    return json({ error: 'no_email', message: 'Please enter a valid email address.' }, 400);
  }

  const endpoint = env.FORMSPREE_ENDPOINT || FORMSPREE_DEFAULT;
  const t = withTimeout(UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: t.signal,
    });
    if (r.ok) return json({ ok: true });

    let detail = '';
    try {
      const d = await r.json();
      detail = (d && d.errors || []).map((x) => x.message).join(' ');
    } catch { /* non-JSON error body */ }
    return json({
      error: 'upstream',
      message: detail || 'The form could not be sent just now. Please email info@premiumwinedelivery.com and we will pick it up.',
    }, 502);
  } catch (e) {
    return json({
      error: e && e.name === 'AbortError' ? 'upstream_timeout' : 'upstream_error',
      message: 'The form could not be sent just now. Please email info@premiumwinedelivery.com and we will pick it up.',
    }, 504);
  } finally {
    t.done();
  }
}

// Anything other than POST gets a clear answer instead of the SPA shell.
export const onRequest = async (ctx) =>
  ctx.request.method === 'POST'
    ? onRequestPost(ctx)
    : json({ error: 'method_not_allowed' }, 405);
