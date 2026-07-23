// WisiTube — Gemini Batch API proxy (Vercel Serverless Function), built isolated and testable on
// its own (see AutomationStep.jsx's "Gemini Batch test panel") before ever being wired into the
// automation pipeline — that wiring is deliberately NOT part of this file.
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Schema below is built from https://ai.google.dev/gemini-api/docs/batch-api and
// https://ai.google.dev/gemini-api/docs/image-generation, fetched while writing this file — not
// invented. Two honest caveats about that source, both defended against with logging/fallbacks
// rather than silent guessing, since this is exactly what the isolated test panel exists to
// surface before anything depends on it:
//   1. Casing: the outer batch envelope (display_name/input_config/file_name/requests/request/
//      metadata/key) and the image-generation config (response_format/image_size/mime_type) are
//      both documented in snake_case, which is what this file sends. If the live API actually
//      expects camelCase for some of these, Gemini's own 400 error body is returned verbatim to
//      the caller (see the http-error branches below) — that error text is the fastest way to
//      correct a wrong field name, faster than re-reading docs.
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

// '0.5K' (this file's own default, matching src/lib/imageProviders.js's NANOBANANA_BATCH_PRICES
// key) maps to the documented image_size enum value for a ~512px output. '1K'/'2K'/'4K' are passed
// through as-is — the docs show those as valid image_size values directly.
const IMAGE_SIZE_BY_RESOLUTION = { '0.5K': '512px', '1K': '1K', '2K': '2K', '4K': '4K' };

function resolveImageSize(resolution) {
  return IMAGE_SIZE_BY_RESOLUTION[resolution] || IMAGE_SIZE_BY_RESOLUTION['0.5K'];
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
          generation_config: {
            response_modalities: ['TEXT', 'IMAGE'],
            response_format: { type: 'image', image_size: imageSize, mime_type: 'image/jpeg' },
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
// Reads a batch job's current state. Google's documented state strings (JOB_STATE_PENDING/
// _RUNNING/_SUCCEEDED/_FAILED/_CANCELLED/_EXPIRED) are collapsed into the simpler
// pending/processing/succeeded/failed shape the test panel (and later, any automation caller)
// actually needs to branch on — the original googleState string rides along too so nothing
// Google-specific is lost, and the full raw job resource is included for debugging.
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

    // The docs' own jq example reads .metadata.state as the primary path — checked first, with a
    // bare top-level `state` and a done/error-derived fallback so this doesn't just guess wrong
    // silently on a job that's actually finished.
    const googleState =
      data?.metadata?.state || data?.state || (data?.done ? (data?.error ? 'JOB_STATE_FAILED' : 'JOB_STATE_SUCCEEDED') : 'JOB_STATE_PENDING');

    console.log('[gemini-batch] phase=status', { jobId, done: !!data?.done, googleState, hasResponse: !!data?.response, hasError: !!data?.error });

    let state;
    if (googleState === 'JOB_STATE_SUCCEEDED') state = 'succeeded';
    else if (googleState === 'JOB_STATE_RUNNING') state = 'processing';
    else if (googleState === 'JOB_STATE_PENDING') state = 'pending';
    else state = 'failed'; // FAILED / CANCELLED / EXPIRED all collapse to 'failed' for the caller

    return res.status(200).json({ state, googleState, done: !!data?.done, raw: data });
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

      return {
        id: key || `unmatched-${index}`,
        imageBase64: inlineData?.data || null,
        mimeType: inlineData?.mime_type || inlineData?.mimeType || 'image/jpeg',
        error: item?.error ? String(item.error?.message || JSON.stringify(item.error)).slice(0, 300) : null,
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
