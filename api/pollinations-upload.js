// WisiTube — Pollinations reference-photo upload proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Pollinations' /upload endpoint requires a secret sk_... key that must never reach the
// browser, so the client uploads the file here and this function forwards it server-side.
//
// Every phase has its own try/catch so a failure anywhere (multipart parsing, the outbound
// fetch, reading/parsing Pollinations' response) returns a clear JSON error with a phase tag
// instead of an uncaught rejection that Vercel turns into a generic platform 502.

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
    console.error('[pollinations-upload] phase=config missing POLLINATIONS_API_KEY env var');
    return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: parse the incoming multipart body.
    let uploaded;
    try {
      const form = formidable({ maxFileSize: 15 * 1024 * 1024 });
      const [, files] = await form.parse(req);
      uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
    } catch (err) {
      console.error('[pollinations-upload] phase=parse-multipart', err?.message, err?.stack);
      return res.status(400).json({ error: 'Could not parse uploaded file', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!uploaded) {
      console.error('[pollinations-upload] phase=parse-multipart no "file" field in form data');
      return res.status(400).json({ error: 'No file provided' });
    }

    // Phase 2: read the temp file formidable wrote to disk back into memory.
    let buffer;
    try {
      buffer = fs.readFileSync(uploaded.filepath);
    } catch (err) {
      console.error('[pollinations-upload] phase=read-temp-file', err?.message, err?.stack);
      return res.status(500).json({ error: 'Could not read uploaded file', detail: String(err?.message || err).slice(0, 300) });
    } finally {
      fs.unlink(uploaded.filepath, () => {});
    }

    // Phase 3: forward the file to Pollinations.
    let response;
    try {
      const blob = new Blob([buffer], { type: uploaded.mimetype || 'application/octet-stream' });
      const forward = new FormData();
      forward.append('file', blob, uploaded.originalFilename || 'reference.jpg');
      response = await fetch('https://gen.pollinations.ai/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: forward,
      });
    } catch (err) {
      console.error('[pollinations-upload] phase=fetch-pollinations', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Pollinations upload endpoint', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 4: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[pollinations-upload] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Pollinations response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[pollinations-upload] phase=pollinations-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: `Pollinations upload failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
    }

    // Phase 5: parse JSON in its own try/catch — a 200 response isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[pollinations-upload] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Pollinations returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    const hash = data.hash || data.id || data.url;
    if (!hash) {
      console.error('[pollinations-upload] phase=extract-hash no hash/id/url field, body=', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'Upload succeeded but returned no image reference' });
    }

    const url = String(hash).startsWith('http') ? hash : `https://media.pollinations.ai/${hash}`;
    return res.status(200).json({ url });
  } catch (err) {
    console.error('[pollinations-upload] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
