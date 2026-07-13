// WisiTube — YouTube series-playlist attachment (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Finds (or creates) a playlist matching the video's series name and adds the video to it. A
// no-op — not an error — when the video has no series, since most videos don't belong to one.
// Independent phase from the upload itself so it can fail and be retried on its own.
//
// WisiTube has no server-side storage: the refresh token lives in the browser's IndexedDB (see
// src/lib/db.js) and is passed in on every call that needs one, including this one.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 30 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';
// Enough pages to find a playlist on any channel this app would realistically manage, without
// risking an unbounded loop against a pathological account.
const MAX_PLAYLIST_PAGES = 5;

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
    let videoId, refreshToken, seriesName;
    try {
      const body = req.body || {};
      videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

      refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshToken) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

      seriesName = typeof body.seriesName === 'string' ? body.seriesName.trim() : '';
    } catch (err) {
      console.error('[youtube-add-to-playlist] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Not every video belongs to a series — this is a deliberate no-op, not an error.
    if (!seriesName) {
      return res.status(200).json({ skipped: true });
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
      console.error('[youtube-add-to-playlist] phase=refresh-token', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not refresh YouTube access', detail: String(err?.message || err).slice(0, 300) });
    }
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // Phase 3: look for an existing playlist with this exact name (case/whitespace-insensitive)
    // across the channel's own playlists.
    let playlistId = null;
    try {
      let pageToken = '';
      for (let page = 0; page < MAX_PLAYLIST_PAGES && !playlistId; page++) {
        const url = new URL('https://www.googleapis.com/youtube/v3/playlists');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('mine', 'true');
        url.searchParams.set('maxResults', '50');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const listRes = await fetch(url.toString(), { headers: authHeader });
        const listText = await listRes.text();
        if (!listRes.ok) {
          console.error('[youtube-add-to-playlist] phase=list-playlists-http-error status=', listRes.status, 'body=', listText.slice(0, 300));
          return res.status(502).json({ error: `Could not list existing playlists (HTTP ${listRes.status})`, detail: listText.slice(0, 300) });
        }
        const listData = JSON.parse(listText);
        const match = (listData.items || []).find(
          (p) => (p.snippet?.title || '').trim().toLowerCase() === seriesName.toLowerCase()
        );
        if (match) playlistId = match.id;
        pageToken = listData.nextPageToken || '';
        if (!pageToken) break;
      }
    } catch (err) {
      console.error('[youtube-add-to-playlist] phase=find-playlist', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not search existing playlists', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 4: create the playlist if none matched.
    let created = false;
    if (!playlistId) {
      try {
        const createRes = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=snippet,status', {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snippet: { title: seriesName, description: `${seriesName} — series` },
            status: { privacyStatus: 'public' },
          }),
        });
        const createText = await createRes.text();
        if (!createRes.ok) {
          console.error('[youtube-add-to-playlist] phase=create-playlist-http-error status=', createRes.status, 'body=', createText.slice(0, 300));
          return res.status(502).json({ error: `Could not create the series playlist (HTTP ${createRes.status})`, detail: createText.slice(0, 300) });
        }
        const createData = JSON.parse(createText);
        playlistId = createData.id;
        created = true;
        if (!playlistId) {
          console.error('[youtube-add-to-playlist] phase=create-playlist no id in response, body=', createText.slice(0, 300));
          return res.status(502).json({ error: 'YouTube did not return a playlist id' });
        }
      } catch (err) {
        console.error('[youtube-add-to-playlist] phase=create-playlist', err?.message, err?.stack);
        return res.status(502).json({ error: 'Could not create the series playlist', detail: String(err?.message || err).slice(0, 300) });
      }
    }

    // Phase 5: add the video to the playlist.
    try {
      const addRes = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
        }),
      });
      const addText = await addRes.text();
      if (!addRes.ok) {
        console.error('[youtube-add-to-playlist] phase=add-item-http-error status=', addRes.status, 'body=', addText.slice(0, 300));
        return res.status(502).json({ error: `Could not add the video to the playlist (HTTP ${addRes.status})`, detail: addText.slice(0, 300) });
      }
    } catch (err) {
      console.error('[youtube-add-to-playlist] phase=add-item', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not add the video to the playlist', detail: String(err?.message || err).slice(0, 300) });
    }

    return res.status(200).json({ playlistId, created });
  } catch (err) {
    console.error('[youtube-add-to-playlist] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
