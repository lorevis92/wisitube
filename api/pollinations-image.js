// WisiTube — Pollinations image-edit proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Reference-photo editing needs the secret sk_... key, which must never reach the browser. The
// client sends the reference image + prompt here in one multipart request; this function forwards
// both straight to Pollinations' OpenAI-compatible /v1/images/edits endpoint (single call, no
// separate upload step) and hands back the resulting image URL.
//
// Every phase has its own try/catch so a failure anywhere (multipart parsing, the outbound fetch,
// reading/parsing Pollinations' response) returns a clear JSON error with a phase tag instead of
// an uncaught rejection that Vercel turns into a generic platform 502.

import formidable from 'formidable';
import fs from 'fs';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (!apiKey) {
    console.error('[pollinations-image] phase=config missing POLLINATIONS_API_KEY env var');
    return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: parse the incoming multipart body (reference image + prompt + dimensions).
    let fields, uploaded;
    try {
      const form = formidable({ maxFileSize: 15 * 1024 * 1024 });
      const [f, files] = await form.parse(req);
      fields = f;
      uploaded = Array.isArray(files.image) ? files.image[0] : files.image;
    } catch (err) {
      console.error('[pollinations-image] phase=parse-multipart', err?.message, err?.stack);
      return res.status(400).json({ error: 'Could not parse the request', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!uploaded) {
      console.error('[pollinations-image] phase=parse-multipart no "image" field in form data');
      return res.status(400).json({ error: 'No reference image provided' });
    }

    const prompt = Array.isArray(fields.prompt) ? fields.prompt[0] : fields.prompt;
    if (!prompt || typeof prompt !== 'string') {
      console.error('[pollinations-image] phase=parse-multipart no "prompt" field in form data');
      fs.unlink(uploaded.filepath, () => {});
      return res.status(400).json({ error: 'Invalid prompt' });
    }
    const width = (Array.isArray(fields.width) ? fields.width[0] : fields.width) || '1280';
    const height = (Array.isArray(fields.height) ? fields.height[0] : fields.height) || '720';

    // Phase 2: read the temp file formidable wrote to disk back into memory.
    let buffer;
    try {
      buffer = fs.readFileSync(uploaded.filepath);
    } catch (err) {
      console.error('[pollinations-image] phase=read-temp-file', err?.message, err?.stack);
      return res.status(500).json({ error: 'Could not read the reference image', detail: String(err?.message || err).slice(0, 300) });
    } finally {
      fs.unlink(uploaded.filepath, () => {});
    }

    // Phase 3: forward the image + prompt to Pollinations' image-edit endpoint in one call.
    let response;
    try {
      const blob = new Blob([buffer], { type: uploaded.mimetype || 'application/octet-stream' });
      const forward = new FormData();
      forward.append('image', blob, uploaded.originalFilename || 'reference.jpg');
      forward.append('prompt', prompt);
      forward.append('model', 'kontext');
      forward.append('size', `${width}x${height}`);
      forward.append('response_format', 'url');
      const targetUrl = 'https://gen.pollinations.ai/v1/images/edits';
      console.log('[proxy] outgoing request URL:', targetUrl);
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: forward,
      });
    } catch (err) {
      console.error('[pollinations-image] phase=fetch-pollinations', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Pollinations image-edit endpoint', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 4: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[pollinations-image] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Pollinations response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[pollinations-image] phase=pollinations-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: `Pollinations image edit failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
    }

    // Phase 5: parse JSON in its own try/catch — a 200 response isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[pollinations-image] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Pollinations returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    // Phase 6: extract the image URL — CreateImageResponse shape is { data: [{ url }] }.
    const url = data?.data?.[0]?.url;
    if (!url) {
      console.error('[pollinations-image] phase=extract-url no data[0].url in body=', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'Image edit succeeded but returned no image URL' });
    }

    return res.status(200).json({ url });
  } catch (err) {
    console.error('[pollinations-image] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
