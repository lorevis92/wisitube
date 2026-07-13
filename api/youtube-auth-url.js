// WisiTube — YouTube OAuth authorization URL generator (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// First step of the per-channel YouTube connection flow: builds the Google OAuth2 consent-screen
// URL the client redirects the browser to. api/youtube-callback.js handles the return trip.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 10 };

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    console.error('[youtube-auth-url] phase=config missing YOUTUBE_CLIENT_ID or YOUTUBE_REDIRECT_URI env var');
    return res.status(500).json({ error: 'YouTube OAuth is not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let channelId;
    try {
      const body = req.body || {};
      channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      if (!channelId) return res.status(400).json({ error: 'Invalid channelId' });
    } catch (err) {
      console.error('[youtube-auth-url] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: build the consent-screen URL. state carries the channelId through Google's
    // redirect untouched, so the callback knows which channel to attach the result to —
    // access_type=offline + prompt=consent forces a refresh_token even on a repeat authorization.
    let authUrl;
    try {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state: channelId,
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } catch (err) {
      console.error('[youtube-auth-url] phase=build-url', err?.message, err?.stack);
      return res.status(500).json({ error: 'Could not build the authorization URL', detail: String(err?.message || err).slice(0, 300) });
    }

    return res.status(200).json({ authUrl });
  } catch (err) {
    console.error('[youtube-auth-url] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
