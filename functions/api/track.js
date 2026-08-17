/**
 * GET/POST /api/track  —  Detrack lookup proxy (Cloudflare Pages Function)
 *
 * The API key never reaches the browser. Set it in the Pages dashboard under
 * Settings → Environment variables:
 *
 *     DETRACK_API_KEY            required
 *     TRACK_REQUIRE_IDENTIFIER   optional, defaults to "true"
 *     TRACK_DEBUG_TOKEN          optional, see "Diagnosing" below
 *
 * ---------------------------------------------------------------------------
 * WHAT A CUSTOMER MAY TYPE
 *
 * Detrack puts three different numbers on a job and customers do not know
 * which one they are holding:
 *
 *     do_number         our own delivery order number
 *     tracking_number   the number in the tracking widget / notification
 *     detrack_number    Detrack's own id, looks like DET6411206273
 *
 * Only ONE of these can be handed to /dn/jobs/show — do_number. That is why
 * this function tries up to three lookups in order:
 *
 *   1. GET /dn/jobs/show/?do_number=…   exact DO match. One call, most cases.
 *   2. GET /dn/jobs?query=…             the documented `query` filter searches
 *                                       "DO number, address, delivery to,
 *                                       notify email, assign to, tracking
 *                                       number and zone".
 *   3. GET /dn/jobs?query=<email>       only when the second factor is an email
 *                                       address. `query` searches notify email,
 *                                       so this returns that customer's jobs and
 *                                       we match detrack_number locally.
 *
 * Step 3 is the ONLY way to resolve a detrack_number: no documented filter
 * searches that field. A DET… number supplied together with a phone number
 * rather than an email therefore cannot be resolved — see README.
 *
 * Whichever step matches, the result is checked against the email or phone
 * number on the order before anything is returned.
 *
 * ---------------------------------------------------------------------------
 * DIAGNOSING
 *
 * Set TRACK_DEBUG_TOKEN to a long random string, then call
 *
 *     /api/track?do_number=…&identifier=…&debug=<that string>
 *
 * and the reply gains a `_debug` object listing each step and the HTTP status
 * Detrack returned. Without the variable set, `debug` is ignored entirely and
 * no diagnostic information is ever exposed.
 */

const API_BASE = 'https://app.detrack.com/api/v2';
const MAX_CANDIDATES = 50;
const UPSTREAM_TIMEOUT_MS = 6000;   // cap for any single Detrack call
const TOTAL_BUDGET_MS = 12000;      // cap for all steps together

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

/* ------------------------------------------------------------------ matching */

/** The three numbers a customer might be reading off a notification. */
function jobHasReference(job, wanted) {
  const w = norm(wanted);
  if (!w) return false;
  return [job.do_number, job.tracking_number, job.detrack_number]
    .some((v) => v && norm(v) === w);
}

/** notify_email may hold several addresses separated by "; " or ",". */
function emailsOf(job) {
  const out = [];
  for (const field of [job.email, job.notify_email, job.deliver_to_collect_from_email]) {
    if (!field) continue;
    for (const part of String(field).split(/[;,]/)) {
      const e = norm(part);
      if (e) out.push(e);
    }
  }
  return out;
}

function identifierMatches(job, supplied) {
  const given = norm(supplied);
  if (!given) return false;

  if (emailsOf(job).includes(given)) return true;

  const givenDigits = digits(supplied);
  if (givenDigits.length >= 7) {
    // compare the last 10 digits so +1 and formatting differences do not matter
    const tail = (s) => s.slice(-10);
    const phones = [job.phone_number, job.contact_phone, job.notify_phone]
      .filter(Boolean).map(digits);
    if (phones.some((p) => p && tail(p) === tail(givenDigits))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- upstream */

/**
 * One call to Detrack, with the response classified rather than thrown away.
 *
 *   ok      200 with a parsed body
 *   miss    400 / 404 / 422 — the job is not there, or we asked in a way this
 *           endpoint does not accept. Not an outage; try the next step.
 *   auth    401 / 403 — the API key is missing, wrong, or lacks permission.
 *           This is a configuration fault and must not be reported as an outage.
 *   rate    429
 *   error   5xx, or a body that would not parse
 *   network the request never completed
 */
async function detrackGet(env, path, params, deadline) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  // Detrack is hosted in Singapore and a slow reply must not leave the customer
  // watching a spinner. Every call is capped, and all the steps share one
  // budget, so the whole lookup answers within TOTAL_BUDGET_MS whatever happens.
  const left = deadline - Date.now();
  if (left <= 0) return { kind: 'network', status: 0 };

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.min(UPSTREAM_TIMEOUT_MS, left));

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-API-KEY': env.DETRACK_API_KEY, Accept: 'application/json' },
      signal: stop.signal,
    });
  } catch {
    return { kind: 'network', status: 0 };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 200) {
    try {
      return { kind: 'ok', status: 200, body: await res.json() };
    } catch {
      return { kind: 'error', status: 200 };
    }
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    return { kind: 'miss', status: res.status };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status };
  if (res.status === 429) return { kind: 'rate', status: res.status };
  return { kind: 'error', status: res.status };
}

/* ------------------------------------------------------------------- response */

/**
 * Detrack's raw status keys are not customer-facing wording. `status` is kept
 * as-is because the page colours the badge from it; `status_label` is what the
 * customer actually reads.
 */
/* Detrack's documented `status` values. These are the only ones it emits —
 * there is no "in_progress", "at_destination" or "cancelled". */
const STATUS_LABELS = {
  info_recv: 'Booked',
  in_transit: 'On its way to us',
  dispatched: 'Scheduled',
  completed: 'Delivered',
  completed_partial: 'Delivered — part order',
  failed: 'Delivery attempted',
  on_hold: 'On hold',
  return: 'Returning to us',
};

/* The documented `milestones[].status` values. */
const MILESTONE_LABELS = {
  info_recv: 'Booked',
  dispatched: 'Scheduled',
  out_for_delivery: 'Out for delivery',
  head_to_delivery: 'Driver on the way',
  head_to_pick_up: 'Driver on the way to collect',
  completed: 'Delivered',
  completed_partial: 'Delivered — part order',
  failed: 'Delivery attempted',
  on_hold: 'On hold',
  return: 'Returning to us',
};

/** Last resort: turn any unknown key into something readable rather than blank. */
const humanise = (key) =>
  key ? String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '';

const label = (map, key) => map[key] || humanise(key);

/**
 * Only the fields the recipient needs. Nothing else is passed through.
 *
 * The key names here are a CONTRACT with renderJob() in index.html — it reads
 * job.service, job.status_label, job.received_at and milestone.label. Renaming
 * anything below silently blanks a row on the page, so change both or neither.
 */
function publicView(job) {
  const photos = [];
  for (let i = 1; i <= 10; i++) {
    const p = job['photo_' + i + '_file_url'];
    if (p) photos.push(p);
  }

  const status = job.primary_job_status || job.status || null;
  const milestones = Array.isArray(job.milestones) ? job.milestones : [];

  return {
    do_number: job.do_number || job.tracking_number || job.detrack_number || null,
    tracking_number: job.tracking_number || null,
    service: job.type || null,
    status,
    // Detrack's own tracking_status is already the customer-facing wording and
    // it says more than `status` does — it separates "Scheduled" from "Out for
    // delivery", which `status` alone (both `dispatched`) cannot.
    status_label: job.tracking_status || label(STATUS_LABELS, status),
    date: job.date || null,
    time_window: [job.time_window_from, job.time_window_to].filter(Boolean).join(' – ') || null,
    deliver_to: job.deliver_to_collect_from || null,
    address: job.address || null,
    received_by: job.received_by_sent_by || null,
    received_at: job.pod_at || job.pod_time || null,
    reason: job.reason || null,
    signature: job.signature_file_url || null,
    photos,
    milestones: milestones.map((m) => ({
      label: label(MILESTONE_LABELS, m.status),
      at: m.created_at || m.assign_time || null,
      reason: m.reason || null,
    })),
  };
}

/* ----------------------------------------------------------------- parameters */

async function readParams(request) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    return {
      do_number: url.searchParams.get('do_number') || url.searchParams.get('tracking'),
      identifier: url.searchParams.get('identifier'),
      debug: url.searchParams.get('debug'),
    };
  }
  const ctype = request.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    try { return await request.json(); } catch { return {}; }
  }
  const form = await request.formData();
  return {
    do_number: form.get('do_number'),
    identifier: form.get('identifier'),
    debug: form.get('debug'),
  };
}

/* ---------------------------------------------------------------------- entry */

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

  const { do_number, identifier, debug } = await readParams(request);
  const ref = String(do_number || '').trim();
  const who = String(identifier || '').trim();

  const steps = [];
  const debugOn = Boolean(env.TRACK_DEBUG_TOKEN) && debug === env.TRACK_DEBUG_TOKEN;
  const withDebug = (payload) => (debugOn ? { ...payload, _debug: { steps } } : payload);

  /** Same reply for "no such shipment" and "wrong identifier", so the endpoint
   *  cannot be used to confirm that a tracking number exists. */
  const notFound = () =>
    json(withDebug({ error: 'not_found', message: 'No shipment matches those details.' }), 404);

  // A plausible reference only; never forward arbitrary input upstream.
  // Must begin and end alphanumeric, so a path fragment such as "../x" or a
  // stray leading slash is refused before it costs an upstream call.
  const REF_OK = /^[A-Za-z0-9](?:[A-Za-z0-9._\-\/]{0,62}[A-Za-z0-9])?$/;
  if (!ref || !REF_OK.test(ref) || ref.includes('..')) return notFound();

  const requireId =
    String(env.TRACK_REQUIRE_IDENTIFIER || 'true').toLowerCase() !== 'false';
  if (requireId && !who) {
    return json(
      withDebug({ error: 'identifier_required',
                  message: 'Enter the email address or phone number on the order.' }),
      400
    );
  }

  // ---------------------------------------------------------------- the lookup
  let job = null;
  let worst = null;   // the most serious upstream problem seen along the way
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const note = (name, r, extra) => {
    steps.push({ step: name, status: r.status, result: r.kind, ...(extra || {}) });
    // auth beats rate beats error/network; a later success still wins overall
    const rank = { network: 1, error: 2, rate: 3, auth: 4 };
    if (rank[r.kind] && (!worst || rank[r.kind] > rank[worst])) worst = r.kind;
  };

  // step 1 — exact DO number
  let r = await detrackGet(env, '/dn/jobs/show/', { do_number: ref }, deadline);
  note('show', r);
  if (r.kind === 'ok' && r.body && r.body.data && !Array.isArray(r.body.data)) {
    job = r.body.data;
  }

  // step 2 — the documented query filter (covers tracking_number)
  if (!job) {
    r = await detrackGet(env, '/dn/jobs', { query: ref, limit: MAX_CANDIDATES }, deadline);
    const list = r.kind === 'ok' && r.body && Array.isArray(r.body.data) ? r.body.data : [];
    note('query_reference', r, { candidates: list.length });
    job = list.find((j) => jobHasReference(j, ref)) || null;
  }

  // step 3 — the customer's own jobs, matched locally (the only route to
  // detrack_number). Requires the second factor to be an email address.
  if (!job && isEmail(who)) {
    r = await detrackGet(env, '/dn/jobs', { query: who, limit: MAX_CANDIDATES }, deadline);
    const list = r.kind === 'ok' && r.body && Array.isArray(r.body.data) ? r.body.data : [];
    note('query_email', r, { candidates: list.length });
    job = list.find((j) => jobHasReference(j, ref)) || null;
  }

  // ------------------------------------------------------------- what happened
  if (!job) {
    // Only report a fault if one actually occurred. A clean set of misses means
    // the shipment genuinely is not there.
    if (worst === 'auth') {
      // Configuration, not an outage. Deliberately vague to the visitor; the
      // real cause is in `_debug` and in the Cloudflare log.
      console.error('[track] Detrack rejected the API key', JSON.stringify(steps));
      return json(withDebug({ error: 'not_configured',
                              message: 'Tracking is not configured yet.' }), 503);
    }
    if (worst === 'rate') {
      return json(withDebug({ error: 'rate_limited',
                              message: 'Too many lookups. Try again in a moment.' }), 429);
    }
    if (worst === 'error' || worst === 'network') {
      console.error('[track] Detrack unavailable', JSON.stringify(steps));
      return json(withDebug({ error: 'upstream_unavailable',
                              message: 'Tracking is temporarily unavailable.' }), 502);
    }
    return notFound();
  }

  if (requireId && !identifierMatches(job, who)) return notFound();

  // The page reads `job`, not `data`. Do not rename this key.
  return json(withDebug({ job: publicView(job) }));
}
