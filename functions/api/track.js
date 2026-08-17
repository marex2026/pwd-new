/**
 * PWD / Cloudflare Pages / Detrack tracking proxy
 *
 * Customer may enter ANY of these Detrack identifiers:
 *   1. detrack_number   e.g. DET6411206273
 *   2. tracking_number e.g. T1234567
 *   3. do_number       e.g. DO123
 *
 * Existing PWD index.html can remain unchanged. It sends:
 *   { do_number: "<whatever customer entered>", identifier: "<email or phone>" }
 *
 * Required Cloudflare secret:
 *   DETRACK_API_KEY
 */

const DETRACK_SHOW = 'https://app.detrack.com/api/v2/dn/jobs/show/';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function digits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function splitEmails(v) {
  return String(v == null ? '' : v)
    .split(/[;,]/)
    .map(norm)
    .filter(Boolean);
}

function identifierMatches(job, supplied) {
  const suppliedText = norm(supplied);

  const emails = [
    ...splitEmails(job.notify_email),
    ...splitEmails(job.email),
    ...splitEmails(job.deliver_to_collect_from_email),
    ...splitEmails(job.customer_email)
  ];

  if (suppliedText && emails.includes(suppliedText)) return true;

  const suppliedDigits = digits(supplied);
  if (suppliedDigits.length >= 7) {
    const phones = [
      job.phone_number,
      job.contact_phone,
      job.notify_phone,
      job.sender_phone_number
    ].filter(Boolean).map(digits);

    const last10 = (s) => s.slice(-10);
    if (phones.some((p) => p && last10(p) === last10(suppliedDigits))) {
      return true;
    }
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

function publicView(job, enteredNumber) {
  const photos = [];

  for (let i = 1; i <= 10; i++) {
    const photo = job['photo_' + i + '_file_url'];
    if (photo) photos.push(photo);
  }

  const milestones = Array.isArray(job.milestones)
    ? job.milestones.map((m) => ({
        label: milestoneLabel(m.status),
        at: m.created_at || m.pod_at || m.assign_time || null,
        reason: m.reason || null
      }))
    : [];

  return {
    // Keep what the customer entered visible on the PWD result.
    do_number:
      enteredNumber ||
      job.detrack_number ||
      job.tracking_number ||
      job.do_number ||
      null,

    detrack_number: job.detrack_number || null,
    tracking_number: job.tracking_number || null,
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

async function readRequest(request) {
  if (request.method === 'GET') {
    const u = new URL(request.url);
    return {
      number:
        u.searchParams.get('tracking') ||
        u.searchParams.get('number') ||
        u.searchParams.get('do_number') ||
        '',
      identifier: u.searchParams.get('identifier') || ''
    };
  }

  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const body = await request.json();

      return {
        // Current PWD index.html sends do_number.
        // Accept extra names too for future compatibility.
        number:
          body.number ||
          body.tracking ||
          body.detrack_number ||
          body.tracking_number ||
          body.do_number ||
          '',
        identifier: body.identifier || ''
      };
    }

    const form = await request.formData();

    return {
      number:
        form.get('number') ||
        form.get('tracking') ||
        form.get('detrack_number') ||
        form.get('tracking_number') ||
        form.get('do_number') ||
        '',
      identifier: form.get('identifier') || ''
    };
  } catch {
    return { number: '', identifier: '' };
  }
}

function extractJob(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Common API shapes.
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.job && typeof payload.job === 'object') {
    return payload.job;
  }

  if (payload.result && typeof payload.result === 'object') {
    return payload.result;
  }

  // Direct job response.
  if (
    payload.detrack_number ||
    payload.tracking_number ||
    payload.do_number ||
    payload.id
  ) {
    return payload;
  }

  return null;
}

async function detrackLookup(apiKey, lookupBody) {
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
      body: JSON.stringify(lookupBody),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildAttempts(number) {
  /*
   * Try ALL THREE identifier types.
   * Order only improves speed; all three are attempted if needed.
   */
  if (/^DET[A-Z0-9]+$/i.test(number)) {
    return [
      { type: 'detrack_number', body: { detrack_number: number } },
      { type: 'tracking_number', body: { tracking_number: number } },
      { type: 'do_number', body: { do_number: number } }
    ];
  }

  return [
    { type: 'tracking_number', body: { tracking_number: number } },
    { type: 'do_number', body: { do_number: number } },
    { type: 'detrack_number', body: { detrack_number: number } }
  ];
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
      {
        error: 'not_configured',
        message: 'Tracking is not configured yet.'
      },
      503
    );
  }

  const input = await readRequest(request);
  const number = String(input.number || '').trim();
  const identifier = String(input.identifier || '').trim();

  if (
    !number ||
    number.length > 64 ||
    !/^[A-Za-z0-9._\-\/]+$/.test(number)
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

  const attempts = buildAttempts(number);
  let sawAuthorizationError = false;

  for (const attempt of attempts) {
    let response;

    try {
      response = await detrackLookup(env.DETRACK_API_KEY, attempt.body);
    } catch (err) {
      const timedOut =
        err &&
        (err.name === 'AbortError' || String(err).toLowerCase().includes('abort'));

      return json(
        {
          error: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
          message: timedOut
            ? 'Detrack took too long to respond.'
            : 'Tracking is temporarily unavailable.'
        },
        502
      );
    }

    if (response.status === 401 || response.status === 403) {
      sawAuthorizationError = true;
      continue;
    }

    if (response.status === 429) {
      return json(
        {
          error: 'rate_limited',
          message: 'Too many tracking lookups. Please try again shortly.'
        },
        429
      );
    }

    // Not found / unsupported lookup field -> try the next identifier type.
    if (response.status === 404 || response.status === 400 || response.status === 422) {
      continue;
    }

    if (!response.ok) {
      // Other Detrack error: keep trying the remaining identifier types.
      continue;
    }

    let payload;

    try {
      payload = await response.json();
    } catch {
      continue;
    }

    const job = extractJob(payload);
    if (!job) continue;

    /*
     * Verify that the job we got actually matches what was entered.
     * This prevents an upstream fallback/default response from exposing
     * an unrelated shipment.
     */
    const numberMatches =
      norm(job.detrack_number) === norm(number) ||
      norm(job.tracking_number) === norm(number) ||
      norm(job.do_number) === norm(number);

    if (!numberMatches) continue;

    if (!identifierMatches(job, identifier)) {
      return json(
        {
          error: 'not_found',
          message: 'No shipment matches those details.'
        },
        404
      );
    }

    // Existing PWD index.html expects: out.data.job
    return json(
      {
        job: publicView(job, number),
        matched_by: attempt.type
      },
      200
    );
  }

  if (sawAuthorizationError) {
    return json(
      {
        error: 'detrack_authorization',
        message: 'Detrack rejected the API credentials.'
      },
      502
    );
  }

  return json(
    {
      error: 'not_found',
      message: 'No shipment matches those details.'
    },
    404
  );
}
