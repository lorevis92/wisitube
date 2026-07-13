// WisiTube — YouTube OAuth access-token refresh (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Access tokens minted by api/youtube-callback.js are short-lived; this exchanges the long-lived
// refresh_token (saved client-side via src/lib/db.js saveYoutubeConnection) for a fresh access
// token. Will be called right before each upload once the upload flow itself exists (Part 2) —
// there's no server-side storage here either, the refresh token is passed in on every call.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[youtube-refresh-token] phase=config missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET env var');
    return res.status(500).json({ error: 'YouTube OAuth is not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let refreshToken;
    try {
      const body = req.body || {};
      refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshToken) return res.status(400).json({ error: 'Invalid refreshToken' });
    } catch (err) {
      console.error('[youtube-refresh-token] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: exchange the refresh token for a fresh access token.
    let response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
        }),
      });
    } catch (err) {
      console.error('[youtube-refresh-token] phase=fetch-token', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach Google', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[youtube-refresh-token] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Google response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[youtube-refresh-token] phase=google-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Google rejected the refresh request', detail: rawText.slice(0, 300) });
    }

    // Phase 4: parse JSON in its own try/catch — a 200 response isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[youtube-refresh-token] phase=parse-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Google returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    const accessToken = data.access_token;
    if (!accessToken) {
      console.error('[youtube-refresh-token] phase=extract-token no access_token, body=', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'Google response missing access token' });
    }

    return res.status(200).json({ accessToken, expiresIn: data.expires_in });
  } catch (err) {
    console.error('[youtube-refresh-token] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
