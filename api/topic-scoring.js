// WisiTube — Topic scoring orchestrator (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Sits between the Content Program Manager's qualitative candidate batch and its final synthesis
// pass (see src/lib/contentProgramManager.js): given a list of candidate topics, scores each one
// against real data — Google Trends search-interest growth and recent YouTube upload competition —
// and hands back a combined score plus a plain-language reasoning string citing the actual numbers.
//
// Both data sources (Google Trends via `google-trends-api`, YouTube Data API via YOUTUBE_API_KEY)
// used to be their own Serverless Functions (api/trends-score.js, api/youtube-competition.js) that
// this file called over HTTP. They're now the in-process computeTrendScore / computeYoutubeCompetition
// functions below — same logic, same return shapes — folded in to stay under Vercel Hobby's
// 12-function cap (see scripts/check-function-count.js). Each still fails soft: a data source that
// errors returns { error: true, message } and the topic is scored on whatever signal remains, never
// a fabricated number.
//
// Fans out with a small concurrency limit (3 at a time) rather than firing every topic at once —
// the YouTube search.list call alone costs ~100 quota units per topic, so a 15-topic batch run
// unthrottled would slam the shared daily budget in one burst; capping concurrency spreads that out
// without meaningfully slowing down a batch that's already background work.
//
// maxDuration set near this plan's ceiling (280s): Google Trends rate-limits tend to hit correlated
// topics together (see computeTrendScore's retry comments), so a burst affecting several of the ~14
// candidates at once can stack several full 2-retry/~14s-each chains even at concurrency 3. A
// function killed for exceeding maxDuration is a platform-level 504 with a non-JSON body, which is
// what actually needs headroom here, not a code fix.
export const config = { maxDuration: 280 };

const CONCURRENCY_LIMIT = 3;
const MAX_TOPICS = 30; // defensive cap — the caller is expected to send ~12-15

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Runs `fn` over `items` with at most `limit` in flight at once. Order of the returned array
// matches `items`, regardless of completion order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ---- Google Trends growth scoring (was api/trends-score.js) ----
//
// Fetches a single 90-day interestOverTime series, then derives three deltas from that one series
// (no extra Trends calls — fewer round trips against a fragile, rate-limited API):
//   Δ90d — average of the first half of the 90-day window vs the average of its second half
//   Δ30d — same half-split logic, applied to just the last 30 days of that same series
//   Δ7d  — same half-split logic, applied to just the last 7 days of that same series
// trend_score = Δ90d*0.20 + Δ30d*0.30 + Δ7d*0.50 (recent movement weighted heaviest).
//
// Returns { keyword, trend_score, error:false, message, deltas, raw } on success, or
// { trend_score: null, error: true, message } on any failure — NEVER a fabricated/estimated score.

// Google Trends values are 0-100. Below this a handful of points swings the % wildly without
// reflecting real absolute interest — flagged, not hidden, so callers can down-weight it.
const LOW_BASELINE_THRESHOLD = 5;

// Same half-split-average logic reused for all three windows (90d/30d/7d): average the first half of
// the window vs the average of its second half, express the move as a %. One function so the three
// deltas are computed identically instead of drifting between per-window definitions.
function halfSplitDelta(values, windowDays) {
  const n = values.length;
  if (n < 2) {
    return { window_days: windowDays, points_used: n, delta_pct: null, avg_first: null, avg_last: null, low_baseline: null, note: 'Not enough data points in this window to compute a delta.' };
  }
  const half = Math.floor(n / 2);
  const firstHalf = values.slice(0, half);
  const lastHalf = values.slice(n - half);
  const avgFirst = average(firstHalf);
  const avgLast = average(lastHalf);

  let deltaPct;
  let note = null;
  if (avgFirst === 0) {
    // Division by zero: 0 -> 0 is genuinely flat (0%), 0 -> anything positive has no defined % —
    // never fabricate a number (e.g. +Infinity or +100%) here.
    deltaPct = avgLast === 0 ? 0 : null;
    if (avgLast !== 0) note = 'Baseline average is 0 — percentage growth is undefined; see avg_first/avg_last for the raw values.';
  } else {
    deltaPct = ((avgLast - avgFirst) / avgFirst) * 100;
  }

  return {
    window_days: windowDays,
    points_used: n,
    delta_pct: deltaPct === null ? null : round2(deltaPct),
    avg_first: round2(avgFirst),
    avg_last: round2(avgLast),
    low_baseline: avgFirst < LOW_BASELINE_THRESHOLD,
    note,
  };
}

async function computeTrendScore(keyword) {
  if (!keyword || keyword.length > 200) {
    return { trend_score: null, error: true, message: 'Invalid keyword' };
  }

  // Dynamic-import the library so a broken/missing install fails here inside a try/catch instead of
  // crashing the whole function at module load time.
  let googleTrends;
  try {
    googleTrends = (await import('google-trends-api')).default;
  } catch (err) {
    console.error('[topic-scoring:trends] phase=load-library', err?.message, err?.stack);
    return { trend_score: null, error: true, message: `Could not load google-trends-api: ${String(err?.message || err).slice(0, 300)}` };
  }

  // Retry only on the one specific symptom confirmed by hand-testing from Vercel: Google
  // intermittently serves an HTML anti-scraping page instead of JSON, clearing again within tens of
  // minutes. A network-level throw is a different failure mode and is NOT retried; neither is a
  // parsed-but-empty result (a legitimate "no data for this keyword").
  const RETRY_DELAYS_MS = [3000, 8000]; // a rate-limit window clears slower than a network blip
  let parsed;
  let lastParseErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let rawResponse;
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 90 * 24 * 60 * 60 * 1000);
      rawResponse = await googleTrends.interestOverTime({ keyword, startTime, endTime });
    } catch (err) {
      console.error('[topic-scoring:trends] phase=fetch-trends', keyword, err?.message, err?.stack);
      return { trend_score: null, error: true, message: `Google Trends request failed: ${String(err?.message || err).slice(0, 300)}` };
    }

    try {
      parsed = JSON.parse(rawResponse);
      lastParseErr = null;
      break;
    } catch (err) {
      lastParseErr = err;
      console.error(
        `[topic-scoring:trends] phase=parse-json attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1}`,
        keyword,
        err?.message,
        'raw=',
        String(rawResponse).slice(0, 300)
      );
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  if (lastParseErr) {
    return {
      trend_score: null,
      error: true,
      message: `Google Trends returned an unparseable response after ${RETRY_DELAYS_MS.length + 1} attempts: ${String(lastParseErr?.message || lastParseErr).slice(0, 300)}`,
    };
  }

  // Extract and normalize the timeline series.
  let series;
  try {
    const timelineData = parsed?.default?.timelineData;
    if (!Array.isArray(timelineData) || timelineData.length === 0) {
      console.error('[topic-scoring:trends] phase=extract-series empty timelineData, keyword=', keyword, 'parsed=', JSON.stringify(parsed).slice(0, 300));
      return { trend_score: null, error: true, message: 'Google Trends returned no data for this keyword' };
    }
    series = timelineData.map((point) => ({
      date: point.formattedTime || null,
      timestamp: point.time ? Number(point.time) * 1000 : null,
      value: Array.isArray(point.value) ? Number(point.value[0]) : Number(point.value),
      is_partial: !!point.isPartial,
    }));
  } catch (err) {
    console.error('[topic-scoring:trends] phase=extract-series', keyword, err?.message, err?.stack);
    return { trend_score: null, error: true, message: `Could not read the Trends series: ${String(err?.message || err).slice(0, 300)}` };
  }

  // Compute the three deltas and the weighted trend_score.
  try {
    // Today's point (if present) is usually isPartial: true — an in-progress day whose value is
    // artificially low. Kept in the raw output for transparency, excluded from delta math.
    const completeValues = series.filter((p) => !p.is_partial).map((p) => p.value);

    const d90 = halfSplitDelta(completeValues, 90);
    const d30 = halfSplitDelta(completeValues.slice(-30), 30);
    const d7 = halfSplitDelta(completeValues.slice(-7), 7);
    const deltas = { d90, d30, d7 };

    let trendScore;
    let scoreMessage;
    if (d90.delta_pct !== null && d30.delta_pct !== null && d7.delta_pct !== null) {
      trendScore = round2(d90.delta_pct * 0.2 + d30.delta_pct * 0.3 + d7.delta_pct * 0.5);
      scoreMessage = null;
    } else {
      // Not an upstream failure — the call succeeded and the raw data is genuine — just not enough
      // clean signal to honestly compute the weighted score. Still error: false.
      trendScore = null;
      scoreMessage = 'trend_score not computed: one or more windows had a zero baseline or too few data points (see deltas for detail).';
    }

    return {
      keyword,
      trend_score: trendScore,
      error: false,
      message: scoreMessage,
      deltas,
      raw: { series, points_count: series.length },
    };
  } catch (err) {
    console.error('[topic-scoring:trends] phase=compute-deltas', keyword, err?.message, err?.stack);
    return { trend_score: null, error: true, message: `Could not compute deltas: ${String(err?.message || err).slice(0, 300)}` };
  }
}

// ---- YouTube recent-competition scoring (was api/youtube-competition.js) ----
//
// Measures how saturated recent YouTube upload activity is for a topic: how many videos were
// published about it recently, how many views they get, how fresh they are. Quota-aware: exactly
// ONE search.list call per topic (100 units against a 10,000/day budget shared with this app's own
// uploads), then one cheap videos.list (1 unit) for view counts.
//
// Returns { keyword, days_back, error:false, message, summary, raw } on success, or
// { error: true, message } on any failure — NEVER a fabricated/estimated value.

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const SEARCH_MAX_RESULTS = 25;
const COMPETITION_DAYS_BACK = 90;

async function computeYoutubeCompetition(keyword) {
  if (!keyword || keyword.length > 200) {
    return { error: true, message: 'Invalid keyword' };
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('[topic-scoring:competition] phase=config missing YOUTUBE_API_KEY env var');
    return { error: true, message: 'YOUTUBE_API_KEY not configured' };
  }

  const daysBack = COMPETITION_DAYS_BACK;

  // search.list — the single quota-costly call (100 units), first page only.
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
      console.error('[topic-scoring:competition] phase=search-http-error status=', searchRes.status, 'body=', searchText.slice(0, 500));
      let googleMessage = searchText.slice(0, 300);
      let googleReason = null;
      try {
        const parsedErr = JSON.parse(searchText);
        if (parsedErr?.error?.message) googleMessage = parsedErr.error.message;
        if (Array.isArray(parsedErr?.error?.errors) && parsedErr.error.errors[0]?.reason) googleReason = parsedErr.error.errors[0].reason;
      } catch {
        /* body wasn't JSON — googleMessage above is already the fallback */
      }
      return { error: true, message: googleMessage, reason: googleReason };
    }

    const searchData = JSON.parse(searchText);
    searchItems = Array.isArray(searchData.items) ? searchData.items : [];
  } catch (err) {
    console.error('[topic-scoring:competition] phase=search', keyword, err?.message, err?.stack);
    return { error: true, message: `YouTube search request failed: ${String(err?.message || err).slice(0, 300)}` };
  }

  // No videos found is a legitimate, informative result (low/no recent competition) — not an error.
  if (searchItems.length === 0) {
    return {
      keyword,
      days_back: daysBack,
      error: false,
      message: null,
      summary: { video_count: 0, avg_views: null, avg_days_since_published: null },
      raw: { videos: [] },
    };
  }

  // videos.list for view counts — cheap (1 unit), one call for the whole batch.
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
      console.error('[topic-scoring:competition] phase=videos-http-error status=', statsRes.status, 'body=', statsText.slice(0, 500));
      let googleMessage = statsText.slice(0, 300);
      try {
        const parsedErr = JSON.parse(statsText);
        if (parsedErr?.error?.message) googleMessage = parsedErr.error.message;
      } catch {
        /* body wasn't JSON — googleMessage above is already the fallback */
      }
      return { error: true, message: googleMessage };
    }

    const statsData = JSON.parse(statsText);
    statsById = new Map((statsData.items || []).map((v) => [v.id, Number(v.statistics?.viewCount ?? NaN)]));
  } catch (err) {
    console.error('[topic-scoring:competition] phase=videos-list', keyword, err?.message, err?.stack);
    return { error: true, message: `YouTube video-stats request failed: ${String(err?.message || err).slice(0, 300)}` };
  }

  // Assemble raw per-video data and compute the summary.
  try {
    const now = Date.now();
    const videos = searchItems.map((item) => {
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

    return {
      keyword,
      days_back: daysBack,
      error: false,
      message: null,
      summary: {
        video_count: videos.length,
        avg_views: avgViews === null ? null : Math.round(avgViews * 10) / 10,
        avg_days_since_published: avgRecency === null ? null : Math.round(avgRecency * 10) / 10,
      },
      raw: { videos },
    };
  } catch (err) {
    console.error('[topic-scoring:competition] phase=compute-summary', keyword, err?.message, err?.stack);
    return { error: true, message: `Could not compute the summary: ${String(err?.message || err).slice(0, 300)}` };
  }
}

// ---- Score combination ----

// Maps a Trends result onto a 0-100 "favorability" scale (higher = more favorable growth) so it's
// comparable to the competition side. trend_score is a weighted blend of three % deltas and isn't
// bounded to ±100 in extreme cases, so this clamps. Returns null — not 0, not 50 — whenever the
// signal genuinely isn't available: a missing signal must never look like a "neutral" one.
function trendFavorability(trends) {
  if (!trends || trends.error || trends.trend_score === null || trends.trend_score === undefined) return null;
  return clamp((trends.trend_score + 100) / 2, 0, 100);
}

// Maps a competition result onto the same 0-100 scale (higher = less saturated = more favorable).
// Two inputs, each normalized independently then averaged:
//  - density: how many of the possible 25 search results were actually filled.
//  - views: recent videos' average view count, log-scaled and capped at 1,000,000 average views.
// Zero videos found is a genuine, favorable reading (100 — wide open), not a missing signal.
function competitionFavorability(competition) {
  if (!competition || competition.error) return null;
  const videoCount = competition.summary?.video_count ?? 0;
  const avgViews = competition.summary?.avg_views ?? 0;
  const density = clamp(videoCount / 25, 0, 1);
  const viewsNormalized = clamp(Math.log10(avgViews + 1) / 6, 0, 1); // log10(1,000,000) = 6
  const penalty = (density * 0.5 + viewsNormalized * 0.5) * 100;
  return 100 - penalty;
}

// Combines the two favorability scores 50/50. When only one signal is available, that one is used
// directly (at full weight) and signal_incomplete is set. When neither is available, score is null:
// never a fabricated number.
function combineScore(trends, competition) {
  const tf = trendFavorability(trends);
  const cf = competitionFavorability(competition);
  if (tf === null && cf === null) return { score: null, signal_incomplete: true };
  if (tf === null || cf === null) return { score: round2(tf !== null ? tf : cf), signal_incomplete: true };
  return { score: round2(tf * 0.5 + cf * 0.5), signal_incomplete: false };
}

function describeTrend(trends) {
  if (!trends || trends.error) return `search interest data unavailable (${trends?.message || 'Google Trends error'})`;
  const d7 = trends.deltas?.d7;
  const d30 = trends.deltas?.d30;
  if (trends.trend_score === null || !d7 || d7.delta_pct === null) {
    return 'search interest signal inconclusive (too little Google Trends data for this keyword)';
  }
  const dir = d7.delta_pct >= 0 ? 'up' : 'down';
  let sentence = `search interest ${dir} ${Math.abs(Math.round(d7.delta_pct))}% over the last 7 days`;
  if (d30 && d30.delta_pct !== null) {
    sentence += ` (30-day: ${d30.delta_pct >= 0 ? '+' : ''}${Math.round(d30.delta_pct)}%)`;
  }
  if (d7.low_baseline) sentence += ' — niche/low search volume, treat this % cautiously';
  return sentence;
}

function describeCompetition(competition) {
  if (!competition || competition.error) return `YouTube competition data unavailable (${competition?.message || 'YouTube API error'})`;
  const { video_count, avg_views } = competition.summary || {};
  const daysBack = competition.days_back || 90;
  if (!video_count) return `no recent videos found on this topic in the last ${daysBack} days — likely under-served`;
  const avgViewsRounded = Math.round(avg_views || 0);
  return `${video_count} video${video_count === 1 ? '' : 's'} published in the last ${daysBack} days, averaging ${avgViewsRounded.toLocaleString('en-US')} views`;
}

// Scores exactly one topic — isolated in its own try/catch so a thrown error (as opposed to the
// { error: true } shape both scorers already return on their own failures) degrades to the same
// "both signals unavailable" result instead of losing the whole batch.
async function scoreOneTopic(topic) {
  let trends = { trend_score: null, error: true, message: 'not attempted' };
  let competition = { error: true, message: 'not attempted' };
  try {
    const [trendsResult, competitionResult] = await Promise.all([
      computeTrendScore(topic).catch((err) => ({ trend_score: null, error: true, message: `trends scoring threw: ${String(err?.message || err).slice(0, 300)}` })),
      computeYoutubeCompetition(topic).catch((err) => ({ error: true, message: `competition scoring threw: ${String(err?.message || err).slice(0, 300)}` })),
    ]);
    trends = trendsResult;
    competition = competitionResult;
  } catch (err) {
    console.error('[topic-scoring] phase=score-one-topic', topic, err?.message, err?.stack);
    trends = { trend_score: null, error: true, message: String(err?.message || err).slice(0, 300) };
    competition = { error: true, message: String(err?.message || err).slice(0, 300) };
  }

  const { score, signal_incomplete } = combineScore(trends, competition);
  const reasoning = `${describeTrend(trends)}. ${describeCompetition(competition)}.`;
  return { topic, score, signal_incomplete, reasoning, trends, competition };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this guarantees
  // we never let an uncaught exception fall through to a platform-level 502.
  try {
    let channelId, candidateTopics;
    try {
      const body = req.body || {};
      channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      candidateTopics = Array.isArray(body.candidateTopics)
        ? [...new Set(body.candidateTopics.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))].slice(0, MAX_TOPICS)
        : [];
      if (!candidateTopics.length) return res.status(400).json({ error: true, message: 'Invalid candidateTopics' });
    } catch (err) {
      console.error('[topic-scoring] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: true, message: `Invalid request body: ${String(err?.message || err).slice(0, 300)}` });
    }

    let results;
    try {
      results = await mapWithConcurrency(candidateTopics, CONCURRENCY_LIMIT, (topic) => scoreOneTopic(topic));
    } catch (err) {
      console.error('[topic-scoring] phase=score-batch', channelId, err?.message, err?.stack);
      return res.status(500).json({ error: true, message: `Could not score candidate topics: ${String(err?.message || err).slice(0, 300)}` });
    }

    return res.status(200).json({ channelId, error: false, results });
  } catch (err) {
    console.error('[topic-scoring] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: true, message: `Server error: ${String(err?.message || err).slice(0, 300)}` });
  }
}
