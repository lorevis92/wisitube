// WisiTube — YouTube recent-competition scoring (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Isolated and independently testable — this file has no dependency on and is not called by
// anything else yet. POST { keyword } and it measures how saturated recent YouTube upload activity
// is for that topic: how many videos were published about it recently, how many views they're
// getting, and how fresh they are.
//
// Quota-aware by design: search.list costs 100 units per call against a 10,000/day budget shared
// with this app's own uploads, so this makes exactly ONE search.list call per request (no paging
// past page 1). videos.list is cheap (1 unit per call) so it's fine to call once for the whole
// batch of results.
//
// Every phase has its own try/catch — a failure anywhere (quota exhausted, network error,
// malformed response) returns { error: true, message } and NEVER a fabricated/estimated value.
// Raw per-video data is always returned alongside the summary for transparency.

export const config = { maxDuration: 60 };

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const SEARCH_MAX_RESULTS = 25;
const DEFAULT_DAYS_BACK = 90;
const MIN_DAYS_BACK = 30;
const MAX_DAYS_BACK = 90;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('[youtube-competition] phase=config missing YOUTUBE_API_KEY env var');
    return res.status(500).json({ error: true, message: 'YOUTUBE_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body. daysBack lets a caller narrow the "recent" window within
    // the 30-90 day range this tool is meant for; defaults to the full 90 days.
    let keyword, daysBack;
    try {
      const body = req.body || {};
      keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
      if (!keyword || keyword.length > 200) {
        return res.status(400).json({ error: true, message: 'Invalid keyword' });
      }
      const rawDaysBack = Number(body.daysBack);
      daysBack = Number.isFinite(rawDaysBack) ? clamp(Math.round(rawDaysBack), MIN_DAYS_BACK, MAX_DAYS_BACK) : DEFAULT_DAYS_BACK;
    } catch (err) {
      console.error('[youtube-competition] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: true, message: `Invalid request body: ${String(err?.message || err).slice(0, 300)}` });
    }

    // Phase 2: search.list — the single quota-costly call (100 units), first page only.
    let searchItems;
    try {
      const publishedAfter = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
      const url = new URL(`${YOUTUBE_API_BASE}/search`);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', keyword);
      url.searchParams.set('type', 'video');
      url.searchParams.set('order', 'date');
      url.searchParams.set('publishedAfter', publishedAfter);
      url.searchParams.set('maxResults', String(SEARCH_MAX_RESULTS));

      const searchRes = await fetch(url.toString());
      const searchText = await searchRes.text();
      if (!searchRes.ok) {
        console.error('[youtube-competition] phase=search-http-error status=', searchRes.status, 'body=', searchText.slice(0, 500));
        let googleMessage = searchText.slice(0, 300);
        let googleReason = null;
        try {
          const parsedErr = JSON.parse(searchText);
          if (parsedErr?.error?.message) googleMessage = parsedErr.error.message;
          if (Array.isArray(parsedErr?.error?.errors) && parsedErr.error.errors[0]?.reason) googleReason = parsedErr.error.errors[0].reason;
        } catch {
          /* body wasn't JSON — googleMessage above is already the fallback */
        }
        return res.status(searchRes.status).json({ error: true, message: googleMessage, reason: googleReason });
      }

      const searchData = JSON.parse(searchText);
      searchItems = Array.isArray(searchData.items) ? searchData.items : [];
    } catch (err) {
      console.error('[youtube-competition] phase=search', keyword, err?.message, err?.stack);
      return res.status(502).json({ error: true, message: `YouTube search request failed: ${String(err?.message || err).slice(0, 300)}` });
    }

    // No videos found is a legitimate, informative result (low/no recent competition) — not an
    // error — so return a zero-filled summary instead of proceeding to a videos.list call with an
    // empty id list.
    if (searchItems.length === 0) {
      return res.status(200).json({
        keyword,
        days_back: daysBack,
        error: false,
        message: null,
        summary: { video_count: 0, avg_views: null, avg_days_since_published: null },
        raw: { videos: [] },
      });
    }

    // Phase 3: videos.list for view counts — cheap (1 unit), one call for the whole batch.
    let statsById;
    try {
      const videoIds = searchItems.map((item) => item.id?.videoId).filter(Boolean);
      const url = new URL(`${YOUTUBE_API_BASE}/videos`);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('part', 'statistics');
      url.searchParams.set('id', videoIds.join(','));

      const statsRes = await fetch(url.toString());
      const statsText = await statsRes.text();
      if (!statsRes.ok) {
        console.error('[youtube-competition] phase=videos-http-error status=', statsRes.status, 'body=', statsText.slice(0, 500));
        let googleMessage = statsText.slice(0, 300);
        try {
          const parsedErr = JSON.parse(statsText);
          if (parsedErr?.error?.message) googleMessage = parsedErr.error.message;
        } catch {
          /* body wasn't JSON — googleMessage above is already the fallback */
        }
        return res.status(statsRes.status).json({ error: true, message: googleMessage });
      }

      const statsData = JSON.parse(statsText);
      statsById = new Map((statsData.items || []).map((v) => [v.id, Number(v.statistics?.viewCount ?? NaN)]));
    } catch (err) {
      console.error('[youtube-competition] phase=videos-list', keyword, err?.message, err?.stack);
      return res.status(502).json({ error: true, message: `YouTube video-stats request failed: ${String(err?.message || err).slice(0, 300)}` });
    }

    // Phase 4: assemble raw per-video data and compute the summary.
    let videos, summary;
    try {
      const now = Date.now();
      videos = searchItems.map((item) => {
        const videoId = item.id?.videoId || null;
        const publishedAt = item.snippet?.publishedAt || null;
        const views = videoId && statsById.has(videoId) ? statsById.get(videoId) : null;
        const daysSincePublished = publishedAt ? (now - new Date(publishedAt).getTime()) / (24 * 60 * 60 * 1000) : null;
        return {
          video_id: videoId,
          title: item.snippet?.title || null,
          channel_title: item.snippet?.channelTitle || null,
          published_at: publishedAt,
          views: Number.isFinite(views) ? views : null,
          days_since_published: daysSincePublished === null ? null : Math.round(daysSincePublished * 10) / 10,
        };
      });

      const viewsKnown = videos.map((v) => v.views).filter((v) => v !== null);
      const recencyKnown = videos.map((v) => v.days_since_published).filter((v) => v !== null);
      const avgViews = viewsKnown.length ? viewsKnown.reduce((sum, v) => sum + v, 0) / viewsKnown.length : null;
      const avgRecency = recencyKnown.length ? recencyKnown.reduce((sum, v) => sum + v, 0) / recencyKnown.length : null;

      summary = {
        video_count: videos.length,
        avg_views: avgViews === null ? null : Math.round(avgViews * 10) / 10,
        avg_days_since_published: avgRecency === null ? null : Math.round(avgRecency * 10) / 10,
      };
    } catch (err) {
      console.error('[youtube-competition] phase=compute-summary', keyword, err?.message, err?.stack);
      return res.status(500).json({ error: true, message: `Could not compute the summary: ${String(err?.message || err).slice(0, 300)}` });
    }

    return res.status(200).json({
      keyword,
      days_back: daysBack,
      error: false,
      message: null,
      summary,
      raw: { videos },
    });
  } catch (err) {
    console.error('[youtube-competition] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: true, message: `Server error: ${String(err?.message || err).slice(0, 300)}` });
  }
}
