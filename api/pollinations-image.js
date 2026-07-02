// WisiTube — Pollinations kontext (image-to-image) generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Kontext generations need the secret sk_... key, which must never reach the browser. The client
// hits this endpoint exactly like it would hit image.pollinations.ai directly (GET, same query
// shape) and gets the raw image bytes back — buildKontextImageUrl() just points here instead.
//
// Every phase has its own try/catch so a failure anywhere (query validation, the outbound fetch,
// reading the response) returns a clear JSON error with a phase tag instead of an uncaught
// rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (!apiKey) {
    console.error('[pollinations-image] phase=config missing POLLINATIONS_API_KEY env var');
    return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the query params.
    let target;
    try {
      const { prompt, image, width = '1280', height = '720', seed = '42' } = req.query || {};
      if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Invalid prompt' });
      if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Invalid reference image URL' });

      target =
        'https://image.pollinations.ai/prompt/' +
        encodeURIComponent(prompt) +
        `?width=${encodeURIComponent(width)}&height=${encodeURIComponent(height)}&seed=${encodeURIComponent(seed)}` +
        `&nologo=true&model=kontext&image=${encodeURIComponent(image)}&referrer=wisitube`;
    } catch (err) {
      console.error('[pollinations-image] phase=validate-query', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request parameters', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: call Pollinations.
    let response;
    try {
      response = await fetch(target, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err) {
      console.error('[pollinations-image] phase=fetch-pollinations', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Pollinations image endpoint', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      let errText = '';
      try {
        errText = await response.text();
      } catch (err) {
        console.error('[pollinations-image] phase=read-error-body', err?.message, err?.stack);
      }
      console.error('[pollinations-image] phase=pollinations-http-error status=', response.status, 'body=', errText.slice(0, 300));
      return res.status(502).json({ error: `Pollinations kontext generation failed (HTTP ${response.status})`, detail: errText.slice(0, 300) });
    }

    // Phase 3: read the raw image bytes.
    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      console.error('[pollinations-image] phase=read-image-bytes', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Pollinations image response', detail: String(err?.message || err).slice(0, 300) });
    }

    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('[pollinations-image] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
