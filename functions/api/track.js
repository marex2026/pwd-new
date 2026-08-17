/**
 * /api/track — Detrack lookup proxy for Cloudflare Pages
 *
 * Cloudflare secret required:
 *   DETRACK_API_KEY
 *
 * Optional:
 *   TRACK_REQUIRE_IDENTIFIER = "false"
 *   (default is true)
 *
 * This version is designed to match the existing PWD index.html tracking UI.
 */

const DETRACK_SHOW = 'https://app.detrack.com/api/v2/dn/jobs/show/';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });

const notFound = () =>
  json({ error: 'not_found', message: 'No shipment matches those details.' }, 404);

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function splitEmails(v) {
  return String(v == null ? '' : v)
    .split(/[;,]/)
    .map(norm)
    .filter(Boolean);
}

function identifierMatches(job, supplied) {
  const given = norm(supplied);
  if (!given) return false;

  const emails = [
    ...splitEmails(job.notify_email),
    ...splitEmails(job.email),
    ...splitEmails(job.deliver_to_collect_from_email),
    ...splitEmails(job.customer_email)
  ];

  if (emails.includes(given)) return true;

  const givenDigits = digits(supplied);
  if (givenDigits.length >= 7) {
    const phones = [
      job.phone_number,
      job.contact_phone,
      job.notify_phone,
      job.sender_phone_number
    ].filter(Boolean).map(digits);

    const tail = (s) => s.slice(-10);
    if (phones.some((p) => p && tail(p) === tail(givenDigits))) return true;
  }

  return false;
}

function statusLabel(job) {
  if (job.tracking_status) return String(job.tracking_status);

  const s = String(job.primary_job_status || job.status || '').toLowerCase();
  const labels = {
    info_recv: 'Info Received',
    in_transit: 'In Transit',
    dispatched: 'In Progress',
    out_for_delivery: 'Out for Delivery',
    out_for_collection: 'Out for Collection',
    head_to_delivery: 'Heading to Delivery',
    head_to_pick_up: 'Heading to Pick Up',
    picked_up: 'Picked Up',
    completed: 'Delivered',
    completed_partial: 'Partially Delivered',
    failed: 'Not Delivered',
    on_hold: 'On Hold',
    return: 'Return',
    cancelled: 'Cancelled'
  };
  return labels[s] || s || 'Status unavailable';
}

function milestoneLabel(status) {
  const s = String(status || '').toLowerCase();
  const labels = {
    info_recv: 'Delivery information received',
    in_transit: 'In transit',
    dispatched: 'In progress',
    out_for_delivery: 'Out for delivery',
    out_for_collection: 'Out for collection',
    head_to_delivery: 'Driver heading to delivery',
    head_to_pick_up: 'Driver heading to pick up',
    picked_up: 'Picked up',
    completed: 'Delivered',
    completed_partial: 'Partially delivered',
    failed: 'Delivery attempt unsuccessful',
    on_hold: 'On hold',
    return: 'Return'
  };
  return labels[s] || String(status || 'Update');
}

/* Convert Detrack's job into exactly the field names the existing
   PWD index.html renderJob() function expects. */
function publicView(job, requestedNumber) {
  const photos = [];
  for (let i = 1; i <= 10; i++) {
    const p = job['photo_' + i + '_file_url'];
    if (p) photos.push(p);
  }

  const milestones = Array.isArray(job.milestones)
    ? job.milestones.map((m) => ({
        label: milestoneLabel(m.status),
        at: m.created_at || m.pod_at || m.assign_time || null,
        reason: m.reason || null
      }))
    : [];

  return {
    // Show the number the customer entered when possible.
    do_number:
      requestedNumber ||
      job.tracking_number ||
      job.detrack_number ||
      job.do_number ||
      null,

    service: job.service_type || job.job_type || job.type || null,
    deliver_to: job.deliver_to_collect_from || job.company_name || null,
    address: job.address || null,

    status: job.primary_job_status || job.status || null,
    status_label: statusLabel(job),

    date: job.date || null,
    time_window:
      job.time_window ||
      [job.time_window_from, job.time_window_to].filter(Boolean).join(' – ') ||
      job.destination_time_window ||
      null,

    received_by: job.received_by_sent_by || null,
    received_at: job.pod_at || job.signed_at || null,
    reason: job.reason || job.note || null,

    signature: job.signature_file_url || null,
    photos,
    milestones
  };
}

async function readParams(request) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    return {
      do_number: url.searchParams.get('do_number') || url.searchParams.get('tracking'),
      identifier: url.searchParams.get('identifier')
    };
  }

  const ctype = request.headers.get('content-type') || '';

  if (ctype.includes('application/json')) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  try {
    const form = await request.formData();
    return {
      do_number: form.get('do_number'),
      identifier: form.get('identifier')
    };
  } catch {
    return {};
  }
}

async function detrackPost(apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    return await fetch(DETRACK_SHOW, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractJob(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Common Detrack/API response shapes.
  if (payload.data && !Array.isArray(payload.data)) return payload.data;
  if (payload.job && typeof payload.job === 'object') return payload.job;

  // If Detrack returned the job object directly.
  if (payload.do_number || payload.detrack_number || payload.tracking_number) {
    return payload;
  }

  return null;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { Allow: 'GET, POST, OPTIONS' }
    });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (!env.DETRACK_API_KEY) {
    return json(
      { error: 'not_configured', message: 'Tracking is not configured yet.' },
      503
    );
  }

  const { do_number, identifier } = await readParams(request);
  const tracking = String(do_number || '').trim();

  if (
    !tracking ||
    tracking.length > 64 ||
    !/^[A-Za-z0-9._\-\/]+$/.test(tracking)
  ) {
    return notFound();
  }

  const requireId =
    String(env.TRACK_REQUIRE_IDENTIFIER || 'true').toLowerCase() !== 'false';

  if (requireId && !String(identifier || '').trim()) {
    return json(
      {
        error: 'identifier_required',
        message: 'Enter the email address or phone number on the order.'
      },
      400
    );
  }

  /*
   * Detrack distinguishes:
   * - do_number
   * - tracking_number
   * - detrack_number (usually starts DET...)
   *
   * Try the most likely field first, then safe fallbacks.
   */
  const attempts = [];

  if (/^DET[A-Za-z0-9]+$/i.test(tracking)) {
    attempts.push({ detrack_number: tracking });
    attempts.push({ do_number: tracking });
  } else {
    attempts.push({ do_number: tracking });
    attempts.push({ tracking_number: tracking });
  }

  let lastStatus = 404;

  for (const lookup of attempts) {
    let upstream;

    try {
      upstream = await detrackPost(env.DETRACK_API_KEY, lookup);
    } catch (err) {
      const timeout =
        err && (err.name === 'AbortError' || String(err).includes('aborted'));

      return json(
        {
          error: timeout ? 'upstream_timeout' : 'upstream_unavailable',
          message: timeout
            ? 'Detrack took too long to respond.'
            : 'Tracking is temporarily unavailable.'
        },
        502
      );
    }

    lastStatus = upstream.status;

    if (upstream.status === 429) {
      return json(
        { error: 'rate_limited', message: 'Too many lookups. Try again in a moment.' },
        429
      );
    }

    // Try another lookup field when Detrack says not found.
    if (upstream.status === 404) continue;

    if (!upstream.ok) {
      let detail = '';
      try {
        detail = (await upstream.text()).slice(0, 300);
      } catch {}

      // Keep the API key private, but return a useful server-side error code.
      return json(
        {
          error: 'upstream_error',
          upstream_status: upstream.status,
          message: 'Detrack rejected the tracking lookup.',
          detail
        },
        502
      );
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      continue;
    }

    const job = extractJob(payload);
    if (!job) continue;

    if (requireId && !identifierMatches(job, identifier)) {
      return notFound();
    }

    // IMPORTANT: existing index.html expects response.job
    return json({ job: publicView(job, tracking) }, 200);
  }

  if (lastStatus === 429) {
    return json({ error: 'rate_limited' }, 429);
  }

  return notFound();
}

