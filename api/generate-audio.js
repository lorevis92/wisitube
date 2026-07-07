// WisiTube — MiniMax Speech-02 HD voice generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Paid cloud voice engine alongside the free local Kokoro TTS (src/lib/tts.js, which runs
// entirely in the browser and never touches this endpoint) — routed through fal.ai, same
// provider and auth key (FAL_KEY) already used for the premium image engines.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 60 };

// MiniMax's language_boost enum uses its own English names for each language — map the app's
// narration-language labels onto it; anything unrecognized falls back to 'auto' detection.
const LANGUAGE_BOOST = {
  English: 'English',
  Italiano: 'Italian',
  Español: 'Spanish',
  Français: 'French',
  Deutsch: 'German',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.error('[generate-audio] phase=config missing FAL_KEY env var');
    return res.status(500).json({ error: 'FAL_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let text, voice, language;
    try {
      const body = req.body || {};
      text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return res.status(400).json({ error: 'Invalid text' });
      if (text.length > 5000) return res.status(400).json({ error: "Text exceeds MiniMax's 5000-character limit" });

      voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'Wise_Woman';
      language = LANGUAGE_BOOST[body.language] || 'auto';
      // body.referenceAudio is accepted for forward-compatibility with future voice cloning, but
      // speech-02-hd only takes a system voice_id, not raw reference audio — nothing to wire up yet.
    } catch (err) {
      console.error('[generate-audio] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: call fal.ai.
    let response;
    try {
      response = await fetch('https://fal.run/fal-ai/minimax/speech-02-hd', {
        method: 'POST',
        headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice_setting: { voice_id: voice },
          language_boost: language,
          // Defaults to 'hex' (inline base64) otherwise — we want a fetchable URL like every
          // other provider in this app returns.
          output_format: 'url',
        }),
      });
    } catch (err) {
      console.error('[generate-audio] phase=fetch-fal', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach fal.ai', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[generate-audio] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the fal.ai response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[generate-audio] phase=fal-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: `MiniMax Speech-02 HD generation failed (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
    }

    // Phase 4: parse JSON in its own try/catch — a 200 response isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-audio] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'fal.ai returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    const audioUrl = data?.audio?.url;
    if (!audioUrl) {
      console.error('[generate-audio] phase=extract-url no audio.url, body=', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'MiniMax Speech-02 HD succeeded but returned no audio URL' });
    }

    const costUsd = Math.ceil((text.length / 1000) * 0.1 * 100) / 100;
    return res.status(200).json({ audioUrl, costUsd });
  } catch (err) {
    console.error('[generate-audio] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
