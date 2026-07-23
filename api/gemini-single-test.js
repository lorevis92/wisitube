// WisiTube — TEMPORARY diagnostic endpoint, not part of the real pipeline. Delete once the
// generic "Request contains an invalid argument" (code: 3) error api/gemini-batch.js's batch items
// are hitting has been root-caused.
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Calls Gemini's plain (non-batch) generateContent endpoint directly, with the exact same
// contents/generationConfig/imageConfig shape api/gemini-batch.js puts inside a single batch
// item's own "request" field — deliberately duplicated here rather than imported, so this file has
// zero coupling to the one it's meant to isolate a problem in (if gemini-batch.js's request-shape
// code changes later while this diagnostic still exists, it should still test the ORIGINAL shape,
// not silently start testing something else).
//
// Purpose: find out whether "Request contains an invalid argument" is caused by the image
// generation request shape itself (contents/generationConfig/imageConfig — in which case this
// single, non-batch call fails with the same error) or by something specific to how
// api/gemini-batch.js wraps that same request inside a batch (in which case this call succeeds).

export const config = { maxDuration: 30 };

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Same model as api/gemini-batch.js's DEFAULT_MODEL — kept as a separate literal here on purpose
// (see file header).
const MODEL = 'gemini-3.1-flash-image-preview';
// Same mapping as api/gemini-batch.js's IMAGE_SIZE_BY_RESOLUTION — '0.5K' is the label this file's
// caller uses, but Gemini's imageConfig.imageSize rejects that literal string for the lowest tier;
// the value it actually accepts there is '512'. '1K'/'2K'/'4K' pass through unchanged.
const IMAGE_SIZE_BY_RESOLUTION = { '0.5K': '512', '1K': '1K', '2K': '2K', '4K': '4K' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gemini-single-test] phase=config missing GEMINI_API_KEY env var');
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  try {
    // Phase 1: validate the request body.
    let prompt, resolution;
    try {
      const body = req.body || {};
      prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return res.status(400).json({ error: 'Invalid prompt' });
      resolution = typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : '0.5K';
      if (!IMAGE_SIZE_BY_RESOLUTION[resolution]) resolution = '0.5K';
    } catch (err) {
      console.error('[gemini-single-test] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: build the exact same request shape a single batch item wraps — no batch envelope
    // at all here, just the plain GenerateContentRequest.
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { imageSize: IMAGE_SIZE_BY_RESOLUTION[resolution] },
      },
    };

    // Phase 3: call generateContent directly (not batchGenerateContent).
    let response;
    try {
      response = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('[gemini-single-test] phase=fetch', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Gemini API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[gemini-single-test] phase=read-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Gemini response body', detail: String(err?.message || err).slice(0, 300) });
    }

    console.log('[gemini-single-test] phase=result', { status: response.status, ok: response.ok, sentPayload: payload, body: rawText });

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null; // not JSON — raw text is still returned below untouched
    }

    // Whatever Google actually sent back — success or error — goes straight to the client
    // unmodified, alongside the exact payload this file sent, so the two can be compared directly.
    return res.status(200).json({
      googleStatus: response.status,
      googleOk: response.ok,
      sentPayload: payload,
      googleResponse: data !== null ? data : rawText,
    });
  } catch (err) {
    console.error('[gemini-single-test] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
