// WisiTube — Gemini Batch API proxy (Vercel Serverless Function), built isolated and testable on
// its own (see AutomationStep.jsx's "Gemini Batch test panel") before ever being wired into the
// automation pipeline — that wiring is deliberately NOT part of this file.
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Schema below started from https://ai.google.dev/gemini-api/docs/batch-api and
// https://ai.google.dev/gemini-api/docs/image-generation, then corrected against what Gemini
// actually accepts once this was live-tested through the isolated test panel — exactly what that
// panel exists for. Two things learned so far, not guessed:
//   1. Casing is mixed, not uniform: the outer batch envelope really is snake_case
//      (display_name/input_config/file_name/requests/request/metadata/key — this part matched the
//      docs and has never errored), but the inner GenerateContentRequest's image-generation config
//      is the standard camelCase used by the rest of the Gemini API — generationConfig /
//      responseModalities / imageConfig / imageSize. An earlier version of this file sent a
//      snake_case response_format/image_size/mime_type block there, which Gemini rejected outright
//      with "Cannot find field" — that's what forced this correction.
//   2. Per-item result mapping: the docs describe "metadata.key" round-tripping a request's custom
//      key into its result, but no single worked example shows a populated result item. `results`
//      below checks metadata.key, then a bare key, before falling back to array position — and
//      always includes the raw per-item object so a mismatch is visible, not silently wrong.
// Only the inline-requests path is implemented (not the file-upload/JSONL path): batches here are
// always small (a handful of test prompts now, at most a few dozen beats per video later), well
// under any inline size limit, so there's no need for the more speculative upload/download flow.

export const config = { maxDuration: 60 };

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Nano Banana 2 Flash — the cheap tier ($0.067/image standard) confirmed available and active even
// though the Batch API docs page (ai.google.dev/gemini-api/docs/batch-api) doesn't explicitly list
// it, likely a stale page rather than an actual restriction. NOT "gemini-3-pro-image-preview" (the
// Pro tier, $0.134/image) — that was this file's original placeholder while only the Pro name
// showed up in the fetched batch docs. If Gemini ever rejects this model with an error explicitly
// saying it isn't supported by the Batch API, that exact message needs to be reported back before
// falling back to the Pro model here.
const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';

// '0.5K' is this file's own (and the UI's) label for the lowest tier — matching
// src/lib/imageProviders.js's NANOBANANA_BATCH_PRICES key — but Gemini's imageConfig.imageSize
// rejects that exact string for the lowest tier; the literal value it accepts there is '512'
// (confirmed live). '1K'/'2K'/'4K' are accepted as-is, no translation needed.
const IMAGE_SIZE_BY_RESOLUTION = { '0.5K': '512', '1K': '1K', '2K': '2K', '4K': '4K' };

function resolveImageSize(resolution) {
  return IMAGE_SIZE_BY_RESOLUTION[resolution] || IMAGE_SIZE_BY_RESOLUTION['0.5K'];
}

// Maps whichever "<PREFIX>_STATE_<NAME>" string Google actually sends to this file's own
// pending/processing/succeeded/failed enum — BATCH_STATE_ is the confirmed-live prefix,
// JOB_STATE_ is kept alongside it in case a different endpoint/version ever uses that one instead
// (the Vertex AI docs this was originally written against suggested it). Anything that isn't one
// of the explicitly recognized names comes back as 'unknown: <raw value>' rather than 'failed' —
// an unrecognized state is not evidence of failure, just of a name this file hasn't been taught yet.
const KNOWN_STATES = {
  BATCH_STATE_PENDING: 'pending',
  JOB_STATE_PENDING: 'pending',
  BATCH_STATE_RUNNING: 'processing',
  JOB_STATE_RUNNING: 'processing',
  BATCH_STATE_SUCCEEDED: 'succeeded',
  JOB_STATE_SUCCEEDED: 'succeeded',
  BATCH_STATE_FAILED: 'failed',
  JOB_STATE_FAILED: 'failed',
  BATCH_STATE_CANCELLED: 'failed',
  JOB_STATE_CANCELLED: 'failed',
  BATCH_STATE_EXPIRED: 'failed',
  JOB_STATE_EXPIRED: 'failed',
};

function mapGoogleState(googleState) {
  if (KNOWN_STATES[googleState]) return KNOWN_STATES[googleState];
  console.error('[gemini-batch] phase=status-unknown-state', googleState);
  return `unknown: ${googleState}`;
}

// Recursively scans the whole parsed status response for any string value shaped like
// "<PREFIX>_STATE_<NAME>", instead of trusting one or two hardcoded field paths (data.state,
// data.metadata.state) — a job reported as BATCH_STATE_SUCCEEDED that this file still labeled
// "failed" means at least one of those assumed paths is wrong, and guessing at a third path would
// just repeat the same mistake. Returns { path, value } for the first match found (depth-first,
// object key order), or null if nothing matches anywhere in the payload.
function findStateAnywhere(obj, path = '') {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && /^(BATCH_STATE_|JOB_STATE_)[A-Z_]+$/.test(v)) {
      return { path: currentPath, value: v };
    }
    if (v && typeof v === 'object') {
      const found = findStateAnywhere(v, currentPath);
      if (found) return found;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gemini-batch] phase=config missing GEMINI_API_KEY env var');
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const action = req.body?.action;
  switch (action) {
    case 'submit':
      return submit(req, res, apiKey);
    case 'status':
      return status(req, res, apiKey);
    case 'results':
      return results(req, res, apiKey);
    default:
      return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

// ---- action=submit ----
//
// Builds one inline batchGenerateContent request from { items: [{ id, prompt }], resolution } and
// submits it. Every item's `id` rides in that item's own `metadata.key` (the documented mechanism
// for mapping a result back to its request) so `results` below can reassemble { id, image } pairs
// in the original order the caller cares about, not just the order Gemini happens to return them.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function submit(req, res, apiKey) {
  try {
    // Phase 1: validate the request body.
    let items, resolution;
    try {
      const body = req.body || {};
      items = Array.isArray(body.items)
        ? body.items
            .filter((it) => it && typeof it.id === 'string' && it.id.trim())
            .map((it) => ({ id: it.id.trim(), prompt: typeof it.prompt === 'string' ? it.prompt.trim() : '' }))
            .filter((it) => it.prompt)
        : [];
      if (!items.length) return res.status(400).json({ error: 'No valid items provided — each needs a string id and a non-empty prompt' });

      const ids = new Set();
      for (const it of items) {
        if (ids.has(it.id)) return res.status(400).json({ error: `Duplicate item id "${it.id}" — ids must be unique within a batch` });
        ids.add(it.id);
      }

      resolution = typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : '0.5K';
    } catch (err) {
      console.error('[gemini-batch] phase=submit-validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: build the batch payload.
    let payload;
    try {
      const imageSize = resolveImageSize(resolution);
      const requests = items.map((it) => ({
        request: {
          contents: [{ parts: [{ text: it.prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { imageSize },
          },
        },
        metadata: { key: it.id },
      }));
      payload = {
        batch: {
          display_name: `wisitube-test-${Date.now()}`,
          input_config: { requests: { requests } },
        },
      };
    } catch (err) {
      console.error('[gemini-batch] phase=submit-build-payload', err?.message, err?.stack);
      return res.status(500).json({ error: 'Could not build the batch request', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: submit to Gemini.
    let response;
    try {
      response = await fetch(`${API_BASE}/models/${DEFAULT_MODEL}:batchGenerateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('[gemini-batch] phase=submit-fetch', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Gemini API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[gemini-batch] phase=submit-read-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Gemini response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      // Gemini's raw error body is returned verbatim (not summarized) — with an unverified request
      // schema, this is the fastest way to see exactly which field name/nesting it rejected.
      console.error('[gemini-batch] phase=submit-http-error status=', response.status, 'body=', rawText.slice(0, 800));
      return res.status(response.status).json({ error: true, status: response.status, detail: rawText.slice(0, 800) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[gemini-batch] phase=submit-parse-json', err?.message, 'raw=', rawText.slice(0, 500));
      return res.status(502).json({ error: 'Gemini returned a non-JSON response', detail: rawText.slice(0, 500) });
    }

    const jobId = data.name;
    if (!jobId) {
      console.error('[gemini-batch] phase=submit-extract-name no name in response, body=', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'Gemini did not return a batch job name', detail: JSON.stringify(data).slice(0, 500) });
    }

    return res.status(200).json({ jobId });
  } catch (err) {
    console.error('[gemini-batch] phase=submit-unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- action=status ----
//
// Reads a batch job's current state. The Batch API docs (written for Vertex AI) suggested a
// JOB_STATE_ prefix, but the real, live response for this endpoint uses BATCH_STATE_ instead
// (confirmed: an in-progress job actually reports BATCH_STATE_RUNNING, not JOB_STATE_RUNNING) —
// mapGoogleState below recognizes both prefixes explicitly rather than assuming one. Anything that
// doesn't match a known state is surfaced as 'unknown: <raw value>', never silently downgraded to
// 'failed' — a state name this file hasn't seen before is not the same thing as a failure, and
// collapsing the two would hide a real success/still-running job behind a false error.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function status(req, res, apiKey) {
  try {
    let jobId;
    try {
      jobId = typeof req.body?.jobId === 'string' ? req.body.jobId.trim() : '';
      if (!jobId) return res.status(400).json({ error: 'Invalid jobId' });
    } catch (err) {
      console.error('[gemini-batch] phase=status-validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    let response;
    try {
      response = await fetch(`${API_BASE}/${jobId}`, { headers: { 'x-goog-api-key': apiKey } });
    } catch (err) {
      console.error('[gemini-batch] phase=status-fetch', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Gemini API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[gemini-batch] phase=status-read-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Gemini response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[gemini-batch] phase=status-http-error status=', response.status, 'body=', rawText.slice(0, 500));
      return res.status(response.status).json({ error: true, status: response.status, detail: rawText.slice(0, 500) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[gemini-batch] phase=status-parse-json', err?.message, 'raw=', rawText.slice(0, 500));
      return res.status(502).json({ error: 'Gemini returned a non-JSON response', detail: rawText.slice(0, 500) });
    }

    // TEMPORARY — full, untruncated dump of exactly what Google returned, requested explicitly
    // after a live job that was actually BATCH_STATE_SUCCEEDED still showed "failed": the previous
    // fix guessed at data.state / data.metadata.state without confirming either path was real.
    // Remove once the real path is confirmed and findStateAnywhere below is proven reliable.
    console.log('[gemini-batch] phase=status-raw-dump', jobId, JSON.stringify(data));

    // Scans the entire response for a BATCH_STATE_*/JOB_STATE_* string anywhere in it, rather than
    // trusting one or two assumed paths — see findStateAnywhere's own comment for why.
    const found = findStateAnywhere(data);
    let googleState;
    let stateSource;
    if (found) {
      googleState = found.value;
      stateSource = found.path;
    } else {
      // No explicit state string anywhere in the payload at all — fall back to a done/error-based
      // guess, but only as a last resort, and logged loudly as exactly that (a guess, not an
      // observed value). data.error can be a present-but-empty object ({}) on a genuine success —
      // that's truthy in JS, so it's checked for actual content, not just presence.
      const hasRealError = data?.error && (typeof data.error !== 'object' || Object.keys(data.error).length > 0);
      googleState = data?.done ? (hasRealError ? 'BATCH_STATE_FAILED' : 'BATCH_STATE_SUCCEEDED') : 'BATCH_STATE_PENDING';
      stateSource = 'inferred from done/error (no explicit state field found)';
    }

    console.log('[gemini-batch] phase=status', { jobId, done: !!data?.done, googleState, stateSource, hasError: !!data?.error });

    const state = mapGoogleState(googleState);

    return res.status(200).json({ state, googleState, stateSource, done: !!data?.done, raw: data });
  } catch (err) {
    console.error('[gemini-batch] phase=status-unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- action=results ----
//
// Downloads/reads the finished job's results and maps each one back to the caller's original id
// via the metadata.key that was set on submit — never assumes result order matches request order,
// falling back to array position only if no key is found at all (logged when that happens, since
// it means the docs' round-trip mechanism didn't work the way described).
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function results(req, res, apiKey) {
  try {
    let jobId;
    try {
      jobId = typeof req.body?.jobId === 'string' ? req.body.jobId.trim() : '';
      if (!jobId) return res.status(400).json({ error: 'Invalid jobId' });
    } catch (err) {
      console.error('[gemini-batch] phase=results-validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    let response;
    try {
      response = await fetch(`${API_BASE}/${jobId}`, { headers: { 'x-goog-api-key': apiKey } });
    } catch (err) {
      console.error('[gemini-batch] phase=results-fetch', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Gemini API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[gemini-batch] phase=results-read-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Gemini response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[gemini-batch] phase=results-http-error status=', response.status, 'body=', rawText.slice(0, 500));
      return res.status(response.status).json({ error: true, status: response.status, detail: rawText.slice(0, 500) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[gemini-batch] phase=results-parse-json', err?.message, 'raw=', rawText.slice(0, 500));
      return res.status(502).json({ error: 'Gemini returned a non-JSON response', detail: rawText.slice(0, 500) });
    }

    if (!data?.done) return res.status(400).json({ error: 'Batch job is not finished yet' });
    if (data?.error) {
      console.error('[gemini-batch] phase=results-job-failed', JSON.stringify(data.error).slice(0, 500));
      return res.status(502).json({ error: 'Batch job failed', detail: JSON.stringify(data.error).slice(0, 500) });
    }

    // Documented path is response.inlinedResponses — checked alongside the snake_case spelling and
    // the doubly-nested form (mirroring the submit request's own "requests": { "requests": [...] }
    // shape), since the docs never showed one fully unified example. Logged plainly if none match.
    const inlined =
      data?.response?.inlinedResponses?.inlinedResponses ||
      data?.response?.inlinedResponses ||
      data?.response?.inlined_responses?.inlined_responses ||
      data?.response?.inlined_responses ||
      [];

    if (!Array.isArray(inlined) || !inlined.length) {
      console.error('[gemini-batch] phase=results-no-inlined-responses body=', rawText.slice(0, 1200));
      return res.status(502).json({ error: 'Could not find inlined responses in the batch result', detail: rawText.slice(0, 1200) });
    }

    let sawUnmatchedKey = false;
    const results = inlined.map((item, index) => {
      const key = item?.metadata?.key || item?.key || null;
      if (!key) sawUnmatchedKey = true;

      const candidateParts = item?.response?.candidates?.[0]?.content?.parts || [];
      const imagePart = candidateParts.find((p) => p?.inline_data || p?.inlineData);
      const inlineData = imagePart?.inline_data || imagePart?.inlineData || null;

      // item.error is whatever shape Gemini sent for this one request — commonly
      // { code, message, status, details: [...] } — but "Request contains an invalid argument" is
      // exactly the kind of message that means nothing without the rest of that object (which
      // field, which value). error stays a short string for at-a-glance status; errorDetail carries
      // the whole thing, untruncated, so the actual cause is visible instead of guessed at again.
      return {
        id: key || `unmatched-${index}`,
        imageBase64: inlineData?.data || null,
        mimeType: inlineData?.mime_type || inlineData?.mimeType || 'image/jpeg',
        error: item?.error ? item.error?.message || 'Request failed' : null,
        errorDetail: item?.error || null,
      };
    });

    if (sawUnmatchedKey) {
      console.error('[gemini-batch] phase=results-unmatched-key one or more result items had no metadata.key/key — falling back to array position, body=', rawText.slice(0, 1200));
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('[gemini-batch] phase=results-unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
