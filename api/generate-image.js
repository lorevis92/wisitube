// WisiTube — Multi-provider image generation gateway (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Single entry point for all three image-generation providers:
// - pollinations (free, default): with no reference image, just hands back Pollinations' public
//   prompt URL — no server round-trip needed, same as the app has always done. With a reference
//   image, forwards to Pollinations' /v1/images/edits multipart endpoint (ported from the retired
//   api/pollinations-image.js) so the secret key stays server-side.
// - nanobanana / gptimage: both routed through fal.ai — one external provider instead of two, one
//   auth key (FAL_KEY) instead of two separate integrations.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

import { priceForImage, resolutionTier } from '../src/lib/imageProviders.js';

export const config = { maxDuration: 60 };

function aspectRatioFromDims(width, height) {
  if (width === height) return '1:1';
  return width > height ? '16:9' : '9:16';
}

function gptImageSizeFromDims(width, height) {
  if (width === height) return 'square_hd';
  return width > height ? 'landscape_16_9' : 'portrait_16_9';
}

// fal.ai's image_urls accept a plain http(s) URL or a data: URI in its place — pass base64
// straight through as a data URI rather than requiring a separate upload-to-storage step.
function toImageUrlEntry(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:')) return ref;
  return `data:image/jpeg;base64,${ref}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let provider, prompt, referenceImages, width, height, seed, quality;
    try {
      const body = req.body || {};
      provider = ['pollinations', 'nanobanana', 'gptimage'].includes(body.provider) ? body.provider : 'pollinations';
      prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return res.status(400).json({ error: 'Invalid prompt' });

      referenceImages = Array.isArray(body.referenceImages)
        ? body.referenceImages.map(toImageUrlEntry).filter(Boolean).slice(0, 14)
        : [];

      width = Math.round(Number(body.width)) || 1280;
      height = Math.round(Number(body.height)) || 720;
      seed = Number.isFinite(Number(body.seed)) ? Math.round(Number(body.seed)) : undefined;
      quality = ['low', 'medium', 'high'].includes(body.quality) ? body.quality : 'medium';
    } catch (err) {
      console.error('[generate-image] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (provider === 'pollinations') return handlePollinations(res, { prompt, referenceImages, width, height, seed });
    if (provider === 'nanobanana') return handleNanoBanana(res, { prompt, referenceImages, width, height, seed });
    return handleGptImage(res, { prompt, referenceImages, width, height, quality });
  } catch (err) {
    console.error('[generate-image] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- Pollinations (free) ----

async function handlePollinations(res, { prompt, referenceImages, width, height, seed }) {
  if (referenceImages.length === 0) {
    // No server round-trip needed — this is the same public, anonymous-tier prompt URL the app
    // has always built client-side; constructing it here just gives every provider one consistent
    // request/response shape to call through.
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      seed: String(seed ?? 42),
      nologo: 'true',
      model: 'flux',
      referrer: 'wisitube',
    });
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
    return res.status(200).json({ imageUrl, provider: 'pollinations', costUsd: 0 });
  }

  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (!apiKey) {
    console.error('[generate-image] phase=config missing POLLINATIONS_API_KEY env var');
    return res.status(500).json({ error: 'POLLINATIONS_API_KEY not configured' });
  }

  // Phase: decode the (data-URI) reference image back into raw bytes for the outbound multipart
  // request — Pollinations' image-edit endpoint requires a real file upload, not a URL/data URI.
  let buffer, mimetype;
  try {
    const match = /^data:([^;]+);base64,(.+)$/.exec(referenceImages[0]);
    if (!match) throw new Error('Reference image must be a data: URI for Pollinations');
    mimetype = match[1];
    buffer = Buffer.from(match[2], 'base64');
  } catch (err) {
    console.error('[generate-image] phase=decode-reference', err?.message, err?.stack);
    return res.status(400).json({ error: 'Could not read the reference image', detail: String(err?.message || err).slice(0, 300) });
  }

  let forward;
  try {
    const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
    forward = new FormData();
    forward.append('image', blob, 'reference.jpg');
    forward.append('prompt', prompt);
    forward.append('model', 'kontext');
    forward.append('size', `${width}x${height}`);
    forward.append('response_format', 'url');
  } catch (err) {
    console.error('[generate-image] phase=build-formdata', err?.message, err?.stack);
    return res.status(500).json({ error: 'Could not prepare the outbound request', detail: String(err?.message || err).slice(0, 300) });
  }

  let response;
  try {
    const targetUrl = 'https://gen.pollinations.ai/v1/images/edits';
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: forward,
    });
  } catch (err) {
    console.error('[generate-image] phase=fetch-pollinations', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not reach the Pollinations image-edit endpoint', detail: String(err?.message || err).slice(0, 300) });
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error('[generate-image] phase=read-response-body', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not read the Pollinations response body', detail: String(err?.message || err).slice(0, 300) });
  }

  if (!response.ok) {
    console.error('[generate-image] phase=pollinations-http-error status=', response.status, 'body=', rawText.slice(0, 300));
    return res.status(502).json({ error: `Pollinations image edit failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[generate-image] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
    return res.status(502).json({ error: 'Pollinations returned a non-JSON response', detail: rawText.slice(0, 300) });
  }

  // CreateImageResponse shape is { data: [{ url }] } in theory, but Pollinations' /v1/images/edits
  // ignores response_format=url and always returns { b64_json } instead — hand the client a data:
  // URL directly rather than a second, fragile network hop through Pollinations' own /upload.
  const remoteUrl = data?.data?.[0]?.url;
  const b64 = data?.data?.[0]?.b64_json;
  const imageUrl = remoteUrl || (b64 ? `data:image/jpeg;base64,${b64}` : null);
  if (!imageUrl) {
    console.error('[generate-image] phase=extract-url no data[0].url or b64_json, body=', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'Image edit succeeded but returned no image data' });
  }

  return res.status(200).json({ imageUrl, provider: 'pollinations', costUsd: 0 });
}

// ---- fal.ai gateway (nanobanana + gptimage) ----

async function handleNanoBanana(res, { prompt, referenceImages, width, height, seed }) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.error('[generate-image] phase=config missing FAL_KEY env var');
    return res.status(500).json({ error: 'FAL_KEY not configured' });
  }

  const body = {
    prompt,
    resolution: resolutionTier(width, height),
    aspect_ratio: aspectRatioFromDims(width, height),
    output_format: 'jpeg',
  };
  if (referenceImages.length) body.image_urls = referenceImages; // up to 14, enforced upstream
  if (seed !== undefined) body.seed = seed;

  let response;
  try {
    response = await fetch('https://fal.run/fal-ai/nano-banana-2', {
      method: 'POST',
      headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[generate-image] phase=fetch-fal', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not reach fal.ai', detail: String(err?.message || err).slice(0, 300) });
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error('[generate-image] phase=read-response-body', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not read the fal.ai response body', detail: String(err?.message || err).slice(0, 300) });
  }

  if (!response.ok) {
    console.error('[generate-image] phase=fal-http-error status=', response.status, 'body=', rawText.slice(0, 300));
    return res.status(502).json({ error: `Nano Banana 2 generation failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[generate-image] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
    return res.status(502).json({ error: 'fal.ai returned a non-JSON response', detail: rawText.slice(0, 300) });
  }

  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    console.error('[generate-image] phase=extract-url no images[0].url, body=', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'Nano Banana 2 succeeded but returned no image URL' });
  }

  return res.status(200).json({ imageUrl, provider: 'nanobanana', costUsd: priceForImage('nanobanana', { width, height }) });
}

async function handleGptImage(res, { prompt, referenceImages, width, height, quality }) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.error('[generate-image] phase=config missing FAL_KEY env var');
    return res.status(500).json({ error: 'FAL_KEY not configured' });
  }

  const hasReference = referenceImages.length > 0;
  // GPT Image 2's text-to-image endpoint has no image input at all — reference images require
  // the separate /edit endpoint.
  const endpoint = hasReference ? 'https://fal.run/openai/gpt-image-2/edit' : 'https://fal.run/openai/gpt-image-2';

  const body = {
    prompt,
    image_size: gptImageSizeFromDims(width, height),
    quality,
    output_format: 'jpeg',
  };
  if (hasReference) body.image_urls = referenceImages;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[generate-image] phase=fetch-fal', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not reach fal.ai', detail: String(err?.message || err).slice(0, 300) });
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error('[generate-image] phase=read-response-body', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not read the fal.ai response body', detail: String(err?.message || err).slice(0, 300) });
  }

  if (!response.ok) {
    console.error('[generate-image] phase=fal-http-error status=', response.status, 'body=', rawText.slice(0, 300));
    return res.status(502).json({ error: `GPT Image 2 generation failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[generate-image] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
    return res.status(502).json({ error: 'fal.ai returned a non-JSON response', detail: rawText.slice(0, 300) });
  }

  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    console.error('[generate-image] phase=extract-url no images[0].url, body=', JSON.stringify(data).slice(0, 300));
    return res.status(502).json({ error: 'GPT Image 2 succeeded but returned no image URL' });
  }

  return res.status(200).json({ imageUrl, provider: 'gptimage', costUsd: priceForImage('gptimage', { quality, hasReference }) });
}
