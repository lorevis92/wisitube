// WisiTube — Topic scoring orchestrator (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Sits between the Content Program Manager's qualitative candidate batch and its final synthesis
// pass (see src/lib/contentProgramManager.js): given a list of candidate topics, scores each one
// against real data — Google Trends growth (api/trends-score.js) and recent YouTube competition
// (api/youtube-competition.js) — and hands back a combined score plus a plain-language reasoning
// string citing the actual numbers.
//
// Fans out with a small concurrency limit (3 at a time) rather than firing every topic at once —
// youtube-competition.js alone costs ~100 quota units per topic, so a 15-topic batch run
// unthrottled would slam the shared daily budget in one burst; capping concurrency spreads that out
// without meaningfully slowing down a batch that's already background work.
//
// Every phase has its own try/catch. A single topic's scoring failure never takes down the batch —
// each topic call is isolated so trends/competition data missing for one topic still lets every
// other topic return normally.

export const config = { maxDuration: 90 };

const APP_URL = process.env.APP_URL || 'https://wisitube.vercel.app';
const CONCURRENCY_LIMIT = 3;
const MAX_TOPICS = 30; // defensive cap — the caller is expected to send ~12-15

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
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

// Maps a Trends result onto a 0-100 "favorability" scale (higher = more favorable growth) so it's
// comparable to the competition side below. trend_score is a weighted blend of three % deltas
// (see api/trends-score.js) and isn't bounded to ±100 in extreme cases, so this clamps rather than
// assuming a fixed range. Returns null — not 0, not 50 — whenever the signal genuinely isn't
// available: a missing signal must never look like a "neutral" or "average" one.
function trendFavorability(trends) {
  if (!trends || trends.error || trends.trend_score === null || trends.trend_score === undefined) return null;
  return clamp((trends.trend_score + 100) / 2, 0, 100);
}

// Maps a competition result onto the same 0-100 scale (higher = less saturated = more favorable).
// Two inputs, each normalized independently then averaged:
//  - density: how many of the possible 25 search results (api/youtube-competition.js's fixed
//    maxResults) were actually filled — more recent uploads on the exact topic = more saturated.
//  - views: recent videos' average view count, log-scaled (views compound, so linear would let one
//    viral outlier dominate the whole score) and capped at 1,000,000 average views as "as saturated
//    as this signal can meaningfully express".
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

// Combines the two favorability scores 50/50 — a reasonable, easily-retuned starting point now
// that both sides are already normalized to the same 0-100 scale, not a fixed law. When only one
// signal is available, that one is used directly (at full weight) rather than silently treating the
// missing half as neutral — and signal_incomplete is set so a consumer knows the score rests on
// half the intended evidence. When neither is available, score is null: never a fabricated number.
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

// Scores exactly one topic — isolated in its own try/catch so a thrown error (network-level, not
// the JSON-with-error:true shape both sub-endpoints already return on their own failures) degrades
// to the same "both signals unavailable" result instead of losing the whole batch.
async function scoreOneTopic(base, topic) {
  let trends = { trend_score: null, error: true, message: 'not attempted' };
  let competition = { error: true, message: 'not attempted' };
  try {
    const [trendsResult, competitionResult] = await Promise.all([
      fetch(`${base}/api/trends-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: topic }),
      })
        .then((r) => r.json())
        .catch((err) => ({ trend_score: null, error: true, message: `trends-score request failed: ${String(err?.message || err).slice(0, 300)}` })),
      fetch(`${base}/api/youtube-competition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: topic }),
      })
        .then((r) => r.json())
        .catch((err) => ({ error: true, message: `youtube-competition request failed: ${String(err?.message || err).slice(0, 300)}` })),
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

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
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

    const base = req.headers.host ? `https://${req.headers.host}` : APP_URL;

    // Phase 2: score every candidate topic, 3 at a time.
    let results;
    try {
      results = await mapWithConcurrency(candidateTopics, CONCURRENCY_LIMIT, (topic) => scoreOneTopic(base, topic));
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
