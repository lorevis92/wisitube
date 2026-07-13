// WisiTube — YouTube OAuth callback (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Second step of the per-channel YouTube connection flow: Google redirects the browser here with
// ?code&state=<channelId> after the user grants consent. Exchanges the code for tokens, looks up
// the name/id of the authorized YouTube channel, then redirects back into the app with everything
// the client needs to persist the connection — WisiTube has no server-side storage, only IndexedDB
// on the client (see src/lib/db.js saveYoutubeConnection), so the tokens have to round-trip here.
//
// Every phase has its own try/catch; a failure at any point redirects back to the app with a
// youtube_error query param rather than showing the user a bare JSON error on a blank Vercel page.

export const config = { maxDuration: 15 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[youtube-callback] phase=config missing YOUTUBE_CLIENT_ID/SECRET or YOUTUBE_REDIRECT_URI env var');
    return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('YouTube OAuth is not configured')}`);
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees the user always lands back in the app instead of a bare Vercel error page.
  try {
    // Phase 1: read code/state from the query string, and bail out cleanly if Google reports the
    // user denied consent (no code in that case).
    let code, channelId;
    try {
      const { code: rawCode, state, error } = req.query || {};
      if (error) {
        return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent(String(error))}`);
      }
      code = typeof rawCode === 'string' ? rawCode : '';
      channelId = typeof state === 'string' ? state : '';
      if (!code || !channelId) {
        return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Missing authorization code or channel')}`);
      }
    } catch (err) {
      console.error('[youtube-callback] phase=parse-query', err?.message, err?.stack);
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Invalid callback request')}`);
    }

    // Phase 2: exchange the authorization code for tokens.
    let tokenResponse;
    try {
      tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
    } catch (err) {
      console.error('[youtube-callback] phase=fetch-token', err?.message, err?.stack);
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Could not reach Google')}`);
    }

    let tokenText;
    try {
      tokenText = await tokenResponse.text();
    } catch (err) {
      console.error('[youtube-callback] phase=read-token-body', err?.message, err?.stack);
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Could not read Google response')}`);
    }

    if (!tokenResponse.ok) {
      console.error('[youtube-callback] phase=token-http-error status=', tokenResponse.status, 'body=', tokenText.slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Google rejected the authorization')}`);
    }

    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch (err) {
      console.error('[youtube-callback] phase=parse-token-json', err?.message, 'raw body=', tokenText.slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Google returned an invalid response')}`);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    if (!accessToken) {
      console.error('[youtube-callback] phase=extract-tokens no access_token, body=', JSON.stringify(tokenData).slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Google response missing access token')}`);
    }
    if (!refreshToken) {
      // Should not happen — prompt=consent in youtube-auth-url.js forces a fresh refresh_token
      // even on a repeat authorization — but surface a clear message instead of silently
      // connecting a channel that can never actually upload.
      console.error('[youtube-callback] phase=extract-tokens no refresh_token, body=', JSON.stringify(tokenData).slice(0, 300));
      return res.redirect(
        302,
        `${APP_URL}/?youtube_error=${encodeURIComponent(
          'Google did not return a refresh token — revoke WisiTube access at myaccount.google.com/permissions and try connecting again'
        )}`
      );
    }

    // Phase 3: look up the name/id of the YouTube channel that was just authorized.
    let channelResponse;
    try {
      channelResponse = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      console.error('[youtube-callback] phase=fetch-channel', err?.message, err?.stack);
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Could not reach YouTube')}`);
    }

    let channelText;
    try {
      channelText = await channelResponse.text();
    } catch (err) {
      console.error('[youtube-callback] phase=read-channel-body', err?.message, err?.stack);
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Could not read YouTube response')}`);
    }

    if (!channelResponse.ok) {
      console.error('[youtube-callback] phase=channel-http-error status=', channelResponse.status, 'body=', channelText.slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Could not fetch your YouTube channel')}`);
    }

    let channelData;
    try {
      channelData = JSON.parse(channelText);
    } catch (err) {
      console.error('[youtube-callback] phase=parse-channel-json', err?.message, 'raw body=', channelText.slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('YouTube returned an invalid response')}`);
    }

    const ytChannel = channelData.items && channelData.items[0];
    if (!ytChannel) {
      console.error('[youtube-callback] phase=extract-channel no items, body=', JSON.stringify(channelData).slice(0, 300));
      return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('No YouTube channel found on this Google account')}`);
    }

    const ytChannelId = ytChannel.id || '';
    const ytName = (ytChannel.snippet && ytChannel.snippet.title) || 'YouTube channel';

    // Phase 4: hand everything back to the client via the redirect's query string — the only
    // place this data can be persisted, since it's read and consumed by App.jsx on mount.
    const redirectParams = new URLSearchParams({
      youtube_connected: channelId,
      yt_name: ytName,
      yt_refresh: refreshToken,
      yt_channel_id: ytChannelId,
    });
    return res.redirect(302, `${APP_URL}/?${redirectParams.toString()}`);
  } catch (err) {
    console.error('[youtube-callback] phase=unexpected', err?.message, err?.stack);
    return res.redirect(302, `${APP_URL}/?youtube_error=${encodeURIComponent('Unexpected server error')}`);
  }
}
