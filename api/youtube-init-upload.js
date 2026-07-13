// WisiTube — YouTube resumable upload session initiator (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// First step of publishing: exchanges the channel's saved refresh token for a fresh access token,
// then opens a YouTube resumable upload session and hands the session URL straight back to the
// client — the actual video bytes go browser -> Google directly (src/lib/youtubeUpload.js) and
// never pass through this function, so there's no Vercel body-size limit on the video itself.
//
// WisiTube has no server-side storage: the refresh token lives in the browser's IndexedDB (see
// src/lib/db.js) and is passed in on every call that needs one, including this one.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 30 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';
const PRIVACY_VALUES = ['public', 'unlisted', 'private'];

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
    let title, description, tags, categoryId, language, privacyStatus, publishAt, madeForKids, refreshToken;
    try {
      const body = req.body || {};
      title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
      if (!title) return res.status(400).json({ error: 'Invalid title' });

      refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshToken) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

      description = typeof body.description === 'string' ? body.description.slice(0, 5000) : '';
      tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 500) : [];
      categoryId = typeof body.categoryId === 'string' && body.categoryId.trim() ? body.categoryId.trim() : '27';
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'en';
      privacyStatus = PRIVACY_VALUES.includes(body.privacyStatus) ? body.privacyStatus : 'public';
      publishAt = typeof body.publishAt === 'string' && body.publishAt.trim() ? body.publishAt.trim() : null;
      madeForKids = !!body.madeForKids;

      // A scheduled video must stay private until YouTube auto-publishes it at publishAt — the
      // API rejects public/unlisted + publishAt combinations outright.
      if (publishAt) privacyStatus = 'private';
    } catch (err) {
      console.error('[youtube-init-upload] phase=validate-body', err?.message, err?.stack);
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
      console.error('[youtube-init-upload] phase=refresh-token', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not refresh YouTube access', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: open the resumable upload session — the response carries the single-use session
    // URL in its Location header, not in the JSON body.
    let initResponse;
    try {
      const snippet = { title, description, tags, categoryId, defaultLanguage: language };
      const status = { privacyStatus, selfDeclaredMadeForKids: madeForKids };
      if (publishAt) status.publishAt = publishAt;

      initResponse = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({ snippet, status }),
      });
    } catch (err) {
      console.error('[youtube-init-upload] phase=fetch-init-session', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach YouTube', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!initResponse.ok) {
      let detail = '';
      try {
        detail = await initResponse.text();
      } catch {
        /* best effort */
      }
      console.error('[youtube-init-upload] phase=init-http-error status=', initResponse.status, 'body=', detail.slice(0, 300));
      return res.status(502).json({ error: `YouTube rejected the upload session (HTTP ${initResponse.status})`, detail: detail.slice(0, 300) });
    }

    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) {
      console.error('[youtube-init-upload] phase=extract-location no Location header on 200 response');
      return res.status(502).json({ error: 'YouTube did not return an upload session URL' });
    }

    return res.status(200).json({ uploadUrl, accessToken });
  } catch (err) {
    console.error('[youtube-init-upload] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
