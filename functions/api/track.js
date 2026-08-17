/**
 * GET/POST /api/track  —  Detrack lookup proxy (Cloudflare Pages Function)
 *
 * The API key never reaches the browser. Set it in the Pages dashboard under
 * Settings → Environment variables:
 *
 *     DETRACK_API_KEY            required
 *     TRACK_REQUIRE_IDENTIFIER   optional, defaults to "true"
 *
 * With the identifier check on (recommended, and the default) a caller must
 * supply BOTH the delivery number and the email address or phone number on the
 * order. A tracking number on its own will not return a signature, a delivery
 * photograph, or an address.
 */

const DETRACK_SHOW = 'https://app.detrack.com/api/v2/dn/jobs/show/';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

/** Identical response for "no such shipment" and "wrong identifier", so the
 *  endpoint cannot be used to confirm that a tracking number exists. */
const notFound = () =>
  json({ error: 'not_found', message: 'No shipment matches those details.' }, 404);

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function identifierMatches(job, supplied) {
  const given = norm(supplied);
  if (!given) return false;

  const emails = [job.email, job.notify_email, job.deliver_to_collect_from_email]
    .filter(Boolean).map(norm);
  if (emails.includes(given)) return true;

  const givenDigits = digits(supplied);
  if (givenDigits.length >= 7) {
    const phones = [job.phone_number, job.contact_phone, job.notify_phone]
      .filter(Boolean).map(digits);
    // compare the last 10 digits so +1 / formatting differences do not matter
    const tail = (s) => s.slice(-10);
    if (phones.some((p) => p && tail(p) === tail(givenDigits))) return true;
  }
  return false;
}

/** Only the fields the recipient needs. Nothing else is passed through. */
function publicView(job) {
  const photos = [];
  for (let i = 1; i <= 10; i++) {
    const p = job['photo_' + i + '_file_url'];
    if (p) photos.push(p);
  }
  return {
    do_number: job.do_number || null,
    type: job.type || null,
    status: job.primary_job_status || job.status || null,
    date: job.date || null,
    time_window: [job.time_window_from, job.time_window_to].filter(Boolean).join(' – ') || null,
    deliver_to: job.deliver_to_collect_from || null,
    address: job.address || null,
    received_by: job.received_by_sent_by || null,
    pod_at: job.pod_at || null,
    signature: job.signature_file_url || null,
    photos,
    milestones: Array.isArray(job.milestones)
      ? job.milestones.map((m) => ({
          status: m.status || null,
          at: m.created_at || m.assign_time || null,
          note: m.reason || null,
        }))
      : [],
  };
}

async function readParams(request) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    return {
      do_number: url.searchParams.get('do_number') || url.searchParams.get('tracking'),
      identifier: url.searchParams.get('identifier'),
    };
  }
  const ctype = request.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    try { return await request.json(); } catch { return {}; }
  }
  const form = await request.formData();
  return { do_number: form.get('do_number'), identifier: form.get('identifier') };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  if (!env.DETRACK_API_KEY) {
    return json({ error: 'not_configured', message: 'Tracking is not configured yet.' }, 503);
  }

  const { do_number, identifier } = await readParams(request);
  const doNo = String(do_number || '').trim();

  // a plausible delivery number only; never forward arbitrary input upstream
  if (!doNo || doNo.length > 64 || !/^[A-Za-z0-9._\-\/]+$/.test(doNo)) return notFound();

  const requireId =
    String(env.TRACK_REQUIRE_IDENTIFIER || 'true').toLowerCase() !== 'false';
  if (requireId && !String(identifier || '').trim()) {
    return json(
      { error: 'identifier_required',
        message: 'Enter the email address or phone number on the order.' },
      400
    );
  }

  let upstream;
  try {
    upstream = await fetch(DETRACK_SHOW + '?do_number=' + encodeURIComponent(doNo), {
      method: 'GET',
      headers: { 'X-API-KEY': env.DETRACK_API_KEY, Accept: 'application/json' },
    });
  } catch {
    return json({ error: 'upstream_unavailable',
                  message: 'Tracking is temporarily unavailable.' }, 502);
  }

  if (upstream.status === 404) return notFound();
  if (upstream.status === 429) {
    return json({ error: 'rate_limited',
                  message: 'Too many lookups. Try again in a moment.' }, 429);
  }
  if (!upstream.ok) {
    return json({ error: 'upstream_error',
                  message: 'Tracking is temporarily unavailable.' }, 502);
  }

  let payload;
  try { payload = await upstream.json(); } catch { return notFound(); }

  const job = payload && payload.data;
  if (!job) return notFound();

  if (requireId && !identifierMatches(job, identifier)) return notFound();

  return json({ data: publicView(job) });
}
