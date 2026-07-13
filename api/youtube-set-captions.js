// WisiTube — YouTube captions upload (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Attaches the .srt file (built client-side, see src/lib/srtBuilder.js) to a video that's just
// finished uploading. Independent phase from the upload itself so it can fail and be retried on
// its own without re-uploading the video.
//
// WisiTube has no server-side storage: the refresh token lives in the browser's IndexedDB (see
// src/lib/db.js) and is passed in on every call that needs one, including this one.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 30 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let videoId, refreshToken, srtContent, language;
    try {
      const body = req.body || {};
      videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

      refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshToken) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

      srtContent = typeof body.srtContent === 'string' ? body.srtContent : '';
      if (!srtContent.trim()) return res.status(400).json({ error: 'Invalid srtContent' });

      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'en';
    } catch (err) {
      console.error('[youtube-set-captions] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: exchange the refresh token for a fresh access token via our own endpoint.
    let accessToken;
    try {
      const base = req.headers.host ? `https://${req.headers.host}` : APP_URL;
      const refreshRes = await fetch(`${base}/api/youtube-refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const refreshData = await refreshRes.json();
      if (!refreshRes.ok || !refreshData.accessToken) {
        throw new Error(refreshData.error || 'Could not refresh the YouTube access token');
      }
      accessToken = refreshData.accessToken;
    } catch (err) {
      console.error('[youtube-set-captions] phase=refresh-token', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not refresh YouTube access', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: upload the caption track — captions.insert requires a multipart/related body (a
    // JSON metadata part followed by the raw .srt part), not the multipart/form-data a browser
    // FormData would produce, so it's built by hand here.
    let response;
    try {
      const boundary = `wisitube_captions_${Date.now()}`;
      const metadata = JSON.stringify({ snippet: { videoId, language, isDraft: false } });
      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n` +
        `${srtContent}\r\n` +
        `--${boundary}--`;

      response = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?part=snippet', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
    } catch (err) {
      console.error('[youtube-set-captions] phase=fetch-captions-upload', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach YouTube', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[youtube-set-captions] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the YouTube response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[youtube-set-captions] phase=upload-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: `YouTube rejected the captions (HTTP ${response.status})`, detail: rawText.slice(0, 300) });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[youtube-set-captions] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
