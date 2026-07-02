// WisiTube — Pollinations reference-photo upload proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Pollinations' /upload endpoint requires a secret sk_... key that must never reach the
// browser, so the client uploads the file here and this function forwards it server-side.

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
  if (!apiKey) return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });

  let uploadedPath = null;
  try {
    const form = formidable({ maxFileSize: 15 * 1024 * 1024 });
    const [, files] = await form.parse(req);
    const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!uploaded) return res.status(400).json({ error: 'No file provided' });
    uploadedPath = uploaded.filepath;

    const buffer = fs.readFileSync(uploaded.filepath);
    const blob = new Blob([buffer], { type: uploaded.mimetype || 'application/octet-stream' });
    const forward = new FormData();
    forward.append('file', blob, uploaded.originalFilename || 'reference.jpg');

    const response = await fetch('https://gen.pollinations.ai/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: forward,
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Pollinations upload failed', detail: errText.slice(0, 300) });
    }

    const data = await response.json();
    const hash = data.hash || data.id || data.url;
    if (!hash) return res.status(502).json({ error: 'Upload succeeded but returned no image reference' });

    const url = String(hash).startsWith('http') ? hash : `https://media.pollinations.ai/${hash}`;
    return res.status(200).json({ url });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 300) });
  } finally {
    if (uploadedPath) fs.unlink(uploadedPath, () => {});
  }
}
