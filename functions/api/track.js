/**
 * Premium Wine Delivery — Detrack tracking proxy
 * FINAL VERIFIED VERSION — 2026-08-17
 *
 * Location in GitHub:
 *   functions/api/track.js
 *
 * Required Cloudflare Pages secret:
 *   DETRACK_API_KEY
 *
 * Existing PWD index.html does NOT need to change.
 *
 * Customer can enter ANY ONE of these Detrack identifiers:
 *   - detrack_number   e.g. DET6411206273
 *   - tracking_number  e.g. T1234567
 *   - do_number        e.g. DO123
 *
 * Customer must also enter EITHER:
 *   - the job's notify_email, OR
 *   - the job's phone_number
 *
 * Detrack V2 lookup method used here:
 *   GET https://app.detrack.com/api/v2/jobs
 *   query=<entered tracking value>
 *   X-API-KEY: <secret>
 *
 * The Detrack V2 official client documents "query" as a loose search
 * across all job attributes. This function then requires an exact match
 * against detrack_number, tracking_number, or do_number before returning
 * any shipment information.
 */

const DETRACK_JOBS_URL = 'https://app.detrack.com/api/v2/jobs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function splitNotifyEmails(value) {
  return String(value == null ? '' : value)
    .split(/[;,]/)
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function trackingNumberMatches(job, entered) {
  const wanted = normalizeText(entered);

  return (
    normalizeText(job.detrack_number) === wanted ||
    normalizeText(job.tracking_number) === wanted ||
    normalizeText(job.do_number) === wanted
  );
}

function emailMatches(job, enteredEmail) {
  const wanted = normalizeText(enteredEmail);
  if (!wanted) return false;

  return splitNotifyEmails(job.notify_email).includes(wanted);
}

function phoneMatches(job, enteredPhone) {
  const wanted = digitsOnly(enteredPhone);
  const stored = digitsOnly(job.phone_number);

  if (!wanted || !stored) return false;

  // Exact normalized match.
  if (wanted === stored) return true;

  // US numbers are often stored with or without country code / punctuation.
  // Compare the final 10 digits when both sides contain at least 10 digits.
  if (wanted.length >= 10 && stored.length >= 10) {
    return wanted.slice(-10) === stored.slice(-10);
  }

  return false;
}

function identifierMatches(job, enteredIdentifier) {
  const value = String(enteredIdentifier || '').trim();
  if (!value) return false;

  // If it looks like an email, verify ONLY against Detrack notify_email.
  if (value.includes('@')) {
    return emailMatches(job, value);
  }

  // Otherwise treat it as a phone number and verify ONLY against
  // Detrack phone_number.
  return phoneMatches(job, value);
}

function statusLabel(job) {
  const raw = String(
    job.tracking_status ||
    job.status ||
    job.primary_job_status ||
    ''
  ).trim();

  const key = raw.toLowerCase().replace(/\s+/g, '_');

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

  return labels[key] || raw || 'Status unavailable';
}

function milestoneLabel(status) {
  const key = String(status || '').trim().toLowerCase();

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

  return labels[key] || String(status || 'Update');
}

function publicJob(job, enteredTrackingNumber) {
  const photos = [];

  for (let i = 1; i <= 10; i++) {
    const url = job['photo_' + i + '_file_url'];
    if (url) photos.push(url);
  }

  const milestones = Array.isArray(job.milestones)
    ? job.milestones.map(m => ({
        label: milestoneLabel(m.status),
        at: m.pod_at || m.created_at || null,
        reason: m.reason || null
      }))
    : [];

  return {
    // Existing PWD index.html displays job.do_number as "Tracking No."
    // Show exactly what the customer entered.
    do_number: enteredTrackingNumber,

    service: job.service_type || job.job_type || job.type || null,
    deliver_to: job.deliver_to_collect_from || null,
    address: job.address || null,

    status: job.status || job.primary_job_status || null,
    status_label: statusLabel(job),

    date: job.date || null,
    time_window:
      job.destination_time_window ||
      job.time_window ||
      (
        job.time_window_from || job.time_window_to
          ? [job.time_window_from, job.time_window_to].filter(Boolean).join(' – ')
          : null
      ),

    received_by: job.received_by_sent_by || null,
    received_at: job.signed_at || job.pod_at || null,
    reason: job.reason || job.note || null,

    signature: job.signature_file_url || null,
    photos,
    milestones
  };
}

async function readBody(request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      return await request.json();
    }

    const form = await request.formData();
    return {
      do_number: form.get('do_number'),
      identifier: form.get('identifier')
    };
  } catch {
    return {};
  }
}

function extractJobs(payload) {
  // Detrack V2 official client consumes response.data as the job list.
  if (payload && Array.isArray(payload.data)) return payload.data;

  // Defensive fallbacks, without trusting them unless exact tracking matches.
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.jobs)) return payload.jobs;

  return [];
}

async function fetchDetrackJobs(apiKey, trackingNumber) {
  const url = new URL(DETRACK_JOBS_URL);

  // Detrack V2 official client:
  // GET /jobs?query=<loose search across all attributes>
  url.searchParams.set('query', trackingNumber);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', '100');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    return await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Allow': 'POST, OPTIONS',
        'Cache-Control': 'no-store'
      }
    });
  }

  if (request.method !== 'POST') {
    return json(
      { error: 'method_not_allowed', message: 'Method not allowed.' },
      405
    );
  }

  if (!env.DETRACK_API_KEY) {
    return json(
      {
        error: 'not_configured',
        message: 'Tracking is not configured yet.'
      },
      503
    );
  }

  const body = await readBody(request);

  // Existing PWD index.html posts the tracking value under "do_number".
  // We intentionally treat it as a generic tracking value because it may
  // actually be a Detrack No., Tracking No., or D.O. No.
  const trackingNumber = String(body.do_number || '').trim();
  const identifier = String(body.identifier || '').trim();

  // This also makes the existing index.html configuration probe using "!"
  // stop here without contacting Detrack.
  if (
    !trackingNumber ||
    trackingNumber.length < 3 ||
    trackingNumber.length > 64 ||
    !/^[A-Za-z0-9._\-\/]+$/.test(trackingNumber)
  ) {
    return json(
      {
        error: 'not_found',
        message: 'No shipment matches those details.'
      },
      404
    );
  }

  if (!identifier) {
    return json(
      {
        error: 'identifier_required',
        message: 'Enter the email address or phone number on the order.'
      },
      400
    );
  }

  let upstream;

  try {
    upstream = await fetchDetrackJobs(env.DETRACK_API_KEY, trackingNumber);
  } catch (err) {
    const timedOut =
      err &&
      (
        err.name === 'AbortError' ||
        String(err).toLowerCase().includes('abort')
      );

    console.error(
      timedOut
        ? 'Detrack tracking request timed out'
        : 'Detrack tracking request failed'
    );

    return json(
      {
        error: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
        message: 'Tracking is temporarily unavailable.'
      },
      502
    );
  }

  if (upstream.status === 401 || upstream.status === 403) {
    console.error('Detrack API rejected credentials:', upstream.status);

    return json(
      {
        error: 'detrack_authorization',
        message: 'Tracking is temporarily unavailable.'
      },
      502
    );
  }

  if (upstream.status === 429) {
    return json(
      {
        error: 'rate_limited',
        message: 'Too many tracking lookups. Please try again shortly.'
      },
      429
    );
  }

  if (!upstream.ok) {
    console.error('Detrack API returned status:', upstream.status);

    return json(
      {
        error: 'upstream_error',
        message: 'Tracking is temporarily unavailable.'
      },
      502
    );
  }

  let payload;

  try {
    payload = await upstream.json();
  } catch {
    console.error('Detrack API returned invalid JSON');

    return json(
      {
        error: 'upstream_invalid_response',
        message: 'Tracking is temporarily unavailable.'
      },
      502
    );
  }

  const jobs = extractJobs(payload);

  // The API search is intentionally broad. Never trust a loose result.
  // Only continue with a job whose one official tracking identifier exactly
  // matches what the customer entered.
  const job = jobs.find(candidate =>
    trackingNumberMatches(candidate, trackingNumber)
  );

  if (!job) {
    return json(
      {
        error: 'not_found',
        message: 'No shipment matches those details.'
      },
      404
    );
  }

  // Privacy/security check:
  // Either notify_email OR phone_number must match the job.
  if (!identifierMatches(job, identifier)) {
    return json(
      {
        error: 'not_found',
        message: 'No shipment matches those details.'
      },
      404
    );
  }

  // Existing PWD index.html expects:
  //   out.status === 200 && out.data.job
  return json(
    {
      job: publicJob(job, trackingNumber)
    },
    200
  );
}
