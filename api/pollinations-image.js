// WisiTube — Pollinations kontext (image-to-image) generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Kontext generations need the secret sk_... key, which must never reach the browser. The client
// hits this endpoint exactly like it would hit image.pollinations.ai directly (GET, same query
// shape) and gets the raw image bytes back — buildKontextImageUrl() just points here instead.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });

  try {
    const { prompt, image, width = '1280', height = '720', seed = '42' } = req.query;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Invalid prompt' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Invalid reference image URL' });

    const target =
      'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(prompt) +
      `?width=${encodeURIComponent(width)}&height=${encodeURIComponent(height)}&seed=${encodeURIComponent(seed)}` +
      `&nologo=true&model=kontext&image=${encodeURIComponent(image)}&referrer=wisitube`;

    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Pollinations kontext generation failed', detail: errText.slice(0, 300) });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 300) });
  }
}
