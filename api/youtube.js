// WisiTube — consolidated YouTube API endpoint (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Vercel Hobby caps a deployment at 12 Serverless Functions. The 7 standalone YouTube endpoints
// were consolidated into this single routed function to stay under that limit. Each case below is
// the original handler's body, moved here unchanged, dispatched by an `action` field — read from
// the POST body for our own client's calls, or from the query string for the OAuth callback, since
// that one is a GET redirect from Google, not a POST from our client:
//
//   action=auth-url        (was api/youtube-auth-url.js)
//   action=callback         (was api/youtube-callback.js)        — GET, query string, no CORS
//   action=refresh-token    (was api/youtube-refresh-token.js)
//   action=init-upload      (was api/youtube-init-upload.js)
//   action=set-thumbnail    (was api/youtube-set-thumbnail.js)
//   action=set-captions     (was api/youtube-set-captions.js)
//   action=add-to-playlist  (was api/youtube-add-to-playlist.js)

export const config = { maxDuration: 90 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';
const AUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');
const PRIVACY_VALUES = ['public', 'unlisted', 'private'];
// Same list as LANGUAGES in src/steps/CreateStep.jsx — maps the full display name to the BCP-47
// code captions.insert requires for snippet.language.
const CAPTION_LANGUAGE_CODES = { English: 'en', Italiano: 'it', Español: 'es', Français: 'fr', Deutsch: 'de' };
// Enough pages to find a playlist on any channel this app would realistically manage, without
// risking an unbounded loop against a pathological account.
const MAX_PLAYLIST_PAGES = 5;

export default async function handler(req, res) {
  const action = req.method === 'GET' ? req.query?.action : (req.body?.action || req.query?.action);

  // callback is Google's GET redirect, not a fetch() from our own client — it never needs (and
  // never gets) a CORS preflight, so it's dispatched before the CORS headers below.
  if (action === 'callback') return callback(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  switch (action) {
    case 'auth-url':
      return authUrl(req, res);
    case 'refresh-token':
      return refreshToken(req, res);
    case 'init-upload':
      return initUpload(req, res);
    case 'set-thumbnail':
      return setThumbnail(req, res);
    case 'set-captions':
      return setCaptions(req, res);
    case 'add-to-playlist':
      return addToPlaylist(req, res);
    default:
      return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

// ---- action=auth-url (was api/youtube-auth-url.js) ----
//
// First step of the per-channel YouTube connection flow: builds the Google OAuth2 consent-screen
// URL the client redirects the browser to. The callback case below handles the return trip.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function authUrl(req, res) {
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
    let authUrlStr;
    try {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: AUTH_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state: channelId,
      });
      authUrlStr = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } catch (err) {
      console.error('[youtube-auth-url] phase=build-url', err?.message, err?.stack);
      return res.status(500).json({ error: 'Could not build the authorization URL', detail: String(err?.message || err).slice(0, 300) });
    }

    return res.status(200).json({ authUrl: authUrlStr });
  } catch (err) {
    console.error('[youtube-auth-url] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- action=callback (was api/youtube-callback.js) ----
//
// Second step of the per-channel YouTube connection flow: Google redirects the browser here with
// ?action=callback&code&state=<channelId> after the user grants consent. Exchanges the code for
// tokens, looks up the name/id of the authorized YouTube channel, then redirects back into the app
// with everything the client needs to persist the connection — WisiTube has no server-side
// storage, only IndexedDB on the client (see src/lib/db.js saveYoutubeConnection), so the tokens
// have to round-trip here.
//
// Every phase has its own try/catch; a failure at any point redirects back to the app with a
// youtube_error query param rather than showing the user a bare JSON error on a blank Vercel page.
async function callback(req, res) {
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
      // Should not happen — prompt=consent in the auth-url case forces a fresh refresh_token
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

// ---- action=refresh-token (was api/youtube-refresh-token.js) ----
//
// Access tokens minted by the callback case are short-lived; this exchanges the long-lived
// refresh_token (saved client-side via src/lib/db.js saveYoutubeConnection) for a fresh access
// token. There's no server-side storage here either, the refresh token is passed in on every call.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function refreshToken(req, res) {
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
    let refreshTokenValue;
    try {
      const body = req.body || {};
      refreshTokenValue = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshTokenValue) return res.status(400).json({ error: 'Invalid refreshToken' });
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
          refresh_token: refreshTokenValue,
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

// ---- action=init-upload (was api/youtube-init-upload.js) ----
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
async function initUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let title, description, tags, categoryId, language, privacyStatus, publishAt, madeForKids, refreshTokenValue;
    try {
      const body = req.body || {};
      title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
      if (!title) return res.status(400).json({ error: 'Invalid title' });

      refreshTokenValue = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshTokenValue) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

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
      const refreshRes = await fetch(`${base}/api/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-token', refreshToken: refreshTokenValue }),
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
          // Google grants CORS on the returned upload session URL based on the Origin of the
          // request that created it — without this, the browser's later cross-origin PUT of the
          // video bytes (src/lib/youtubeUpload.js) gets blocked by CORS.
          Origin: 'https://wisitube.vercel.app',
        },
        body: JSON.stringify({ snippet, status }),
      });
    } catch (err) {
      console.error('[youtube-init-upload] phase=fetch-init-session', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach YouTube', detail: String(err?.message || err).slice(0, 300) });
    }

    // TEMPORARY debug logging: dump every response header Google sent back on session creation
    // (Access-Control-* in particular) to see exactly what CORS grant, if any, is attached to the
    // returned upload session URL. Remove once the CORS issue on the resumable upload is confirmed
    // fixed.
    console.log(
      '[youtube-init-upload] phase=debug-session-headers',
      JSON.stringify(Object.fromEntries(initResponse.headers.entries()))
    );

    if (!initResponse.ok) {
      let bodyText = '';
      try {
        bodyText = await initResponse.text();
      } catch {
        /* best effort */
      }
      // Google's error body is normally { error: { message, errors: [{ reason, ... }] } } — pull
      // both out generically and pass them straight through, rather than hardcoding a message for
      // any one specific reason (uploadLimitExceeded, quotaExceeded, etc.). Falls back to the raw
      // body text if it isn't JSON.
      let googleMessage = bodyText.slice(0, 300);
      let googleReason = null;
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed?.error?.message) googleMessage = parsed.error.message;
        if (Array.isArray(parsed?.error?.errors) && parsed.error.errors[0]?.reason) {
          googleReason = parsed.error.errors[0].reason;
        }
      } catch {
        /* body wasn't JSON — bodyText above is already the fallback */
      }
      console.error('[youtube-init-upload] phase=init-http-error status=', initResponse.status, 'body=', bodyText.slice(0, 300));
      return res.status(initResponse.status).json({ error: true, status: initResponse.status, detail: googleMessage, reason: googleReason || null });
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

// ---- action=set-thumbnail (was api/youtube-set-thumbnail.js) ----
//
// Attaches the custom thumbnail (already rendered client-side onto a canvas, see ExportStep.jsx)
// to a video that's just finished uploading. Independent phase from the upload itself so it can
// fail and be retried on its own without re-uploading the video.
//
// WisiTube has no server-side storage: the refresh token lives in the browser's IndexedDB (see
// src/lib/db.js) and is passed in on every call that needs one, including this one.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
async function setThumbnail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let videoId, refreshTokenValue, imageBuffer;
    try {
      const body = req.body || {};
      videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

      refreshTokenValue = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshTokenValue) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

      const raw = typeof body.thumbnailBlob === 'string' ? body.thumbnailBlob : '';
      if (!raw) return res.status(400).json({ error: 'Invalid thumbnailBlob' });
      // Accept both a bare base64 payload and a full data: URL — strip the prefix if present.
      const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      imageBuffer = Buffer.from(base64, 'base64');
      if (!imageBuffer.length) return res.status(400).json({ error: 'Empty thumbnailBlob' });
    } catch (err) {
      console.error('[youtube-set-thumbnail] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: exchange the refresh token for a fresh access token via our own endpoint.
    let accessToken;
    try {
      const base = req.headers.host ? `https://${req.headers.host}` : APP_URL;
      const refreshRes = await fetch(`${base}/api/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-token', refreshToken: refreshTokenValue }),
      });
      const refreshData = await refreshRes.json();
      if (!refreshRes.ok || !refreshData.accessToken) {
        throw new Error(refreshData.error || 'Could not refresh the YouTube access token');
      }
      accessToken = refreshData.accessToken;
    } catch (err) {
      console.error('[youtube-set-thumbnail] phase=refresh-token', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not refresh YouTube access', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: upload the thumbnail — a simple binary media upload, no JSON metadata part needed.
    let response;
    try {
      response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/png',
        },
        body: imageBuffer,
      });
    } catch (err) {
      console.error('[youtube-set-thumbnail] phase=fetch-thumbnail-upload', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach YouTube', detail: String(err?.message || err).slice(0, 300) });
    }

    let bodyText;
    try {
      bodyText = await response.text();
    } catch (err) {
      console.error('[youtube-set-thumbnail] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the YouTube response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[youtube-set-thumbnail] phase=upload-http-error status=', response.status, 'body=', bodyText.slice(0, 300));
      return res.status(response.status).json({ error: true, status: response.status, detail: bodyText.slice(0, 300) });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[youtube-set-thumbnail] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- action=set-captions (was api/youtube-set-captions.js) ----
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
async function setCaptions(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let videoId, refreshTokenValue, srtContent, language, languageName;
    try {
      const body = req.body || {};
      videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

      refreshTokenValue = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshTokenValue) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

      srtContent = typeof body.srtContent === 'string' ? body.srtContent : '';
      if (!srtContent.trim()) return res.status(400).json({ error: 'Invalid srtContent' });

      // Accept either the full display name ("English") or an already-converted BCP-47 code
      // ("en") — captions.insert rejects anything else for snippet.language, so always resolve
      // through CAPTION_LANGUAGE_CODES instead of trusting the raw value we were sent.
      const rawLanguage = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      if (CAPTION_LANGUAGE_CODES[rawLanguage]) {
        languageName = rawLanguage;
        language = CAPTION_LANGUAGE_CODES[rawLanguage];
      } else {
        const nameEntry = Object.entries(CAPTION_LANGUAGE_CODES).find(([, code]) => code === rawLanguage.toLowerCase());
        languageName = nameEntry ? nameEntry[0] : rawLanguage;
        language = nameEntry ? nameEntry[1] : rawLanguage.toLowerCase();
      }
    } catch (err) {
      console.error('[youtube-set-captions] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 2: exchange the refresh token for a fresh access token via our own endpoint.
    let accessToken;
    try {
      const base = req.headers.host ? `https://${req.headers.host}` : APP_URL;
      const refreshRes = await fetch(`${base}/api/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-token', refreshToken: refreshTokenValue }),
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
      // name is required by captions.insert — it's the caption track's display name, not a
      // language code, so the full language name ("English") fits the purpose without needing
      // any user-facing input we don't already have.
      const metadata = JSON.stringify({ snippet: { videoId, language, name: languageName, isDraft: false } });
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
      return res.status(response.status).json({ error: true, status: response.status, detail: rawText.slice(0, 300) });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[youtube-set-captions] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// ---- action=add-to-playlist (was api/youtube-add-to-playlist.js) ----
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
async function addToPlaylist(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let videoId, refreshTokenValue, seriesName;
    try {
      const body = req.body || {};
      videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

      refreshTokenValue = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
      if (!refreshTokenValue) return res.status(400).json({ error: 'This channel is not connected to YouTube' });

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
      const refreshRes = await fetch(`${base}/api/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-token', refreshToken: refreshTokenValue }),
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
        // Google reports a video already in the target playlist as an error (commonly reason
        // videoAlreadyInPlaylist), but the outcome the caller actually wants — the video being in
        // the playlist — is already true, so this isn't a real failure.
        const lowerBody = addText.toLowerCase();
        const isDuplicate =
          lowerBody.includes('alreadyinplaylist') || lowerBody.includes('already in the playlist') || lowerBody.includes('duplicate');
        if (isDuplicate) {
          console.warn('[youtube-add-to-playlist] phase=add-item video already in playlist, treating as success. body=', addText.slice(0, 300));
          return res.status(200).json({ playlistId, created });
        }
        console.error('[youtube-add-to-playlist] phase=add-item-http-error status=', addRes.status, 'body=', addText.slice(0, 300));
        return res.status(addRes.status).json({ error: true, status: addRes.status, detail: addText.slice(0, 300) });
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
