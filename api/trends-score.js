// WisiTube — Google Trends growth scoring (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Isolated and independently testable — this file has no dependency on and is not called by
// anything else yet. POST { keyword } and it scores how much search interest for that keyword has
// been growing recently, using Google Trends' interestOverTime.
//
// Built on `google-trends-api`, an unofficial scraper — its own maintainers warn some endpoints are
// "heavily rate limited" by Google and can fail unpredictably. Every phase below therefore has its
// own try/catch, and a failure anywhere returns { trend_score: null, error: true, message } —
// NEVER a fabricated or estimated score. If this proves too unreliable in practice, the plan is to
// evaluate @alkalisummer/google-trends-js as a replacement for the phase-2 call only; everything
// else here (validation, delta math, response shape) would carry over unchanged.
//
// Growth math: fetch a single 90-day interestOverTime series, then derive three deltas from that
// one series (no extra Trends calls — fewer round trips against a fragile, rate-limited API):
//   Δ90d — average of the first half of the 90-day window vs the average of its second half
//   Δ30d — same half-split logic, applied to just the last 30 days of that same series
//   Δ7d  — same half-split logic, applied to just the last 7 days of that same series
// trend_score = Δ90d*0.20 + Δ30d*0.30 + Δ7d*0.50 (recent movement weighted heaviest).
//
// Numeric robustness: a % delta is unstable near a zero baseline (2 -> 8 is "+300%" on an
// essentially niche/negligible signal). Every delta object below carries avg_first/avg_last (the
// raw 0-100 Trends values behind the %) and a low_baseline flag, so a consumer can tell a genuine
// breakout from a near-zero-baseline artifact instead of trusting the percentage alone.

export const config = { maxDuration: 60 };

// Google Trends values are 0-100. Below this, a handful of points either way swings the % wildly
// without reflecting real absolute interest — flagged, not hidden, so callers can down-weight it.
const LOW_BASELINE_THRESHOLD = 5;

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

// Same half-split-average logic reused for all three windows (90d/30d/7d): average the first half
// of the window vs the average of its second half, express the move as a %. Kept as one function so
// the three deltas are computed identically instead of drifting between hand-picked "first N days"
// definitions per window.
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
    // never fabricate a number (e.g. treating it as +Infinity or +100%) here.
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ trend_score: null, error: true, message: 'Method not allowed' });

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502 — the
  // contract with callers is trend_score: null + error: true on any failure, never a bare crash.
  try {
    // Phase 1: validate the request body.
    let keyword;
    try {
      const body = req.body || {};
      keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
      if (!keyword || keyword.length > 200) {
        return res.status(400).json({ trend_score: null, error: true, message: 'Invalid keyword' });
      }
    } catch (err) {
      console.error('[trends-score] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ trend_score: null, error: true, message: `Invalid request body: ${String(err?.message || err).slice(0, 300)}` });
    }

    // Phase 2: dynamic-import the library so a broken/missing install can't crash the whole
    // function at module load time — it fails inside this try/catch instead.
    let googleTrends;
    try {
      googleTrends = (await import('google-trends-api')).default;
    } catch (err) {
      console.error('[trends-score] phase=load-library', err?.message, err?.stack);
      return res.status(500).json({ trend_score: null, error: true, message: `Could not load google-trends-api: ${String(err?.message || err).slice(0, 300)}` });
    }

    // Phase 3+4: call Google Trends for the 90-day interestOverTime series and parse it, retrying
    // on the one specific symptom confirmed by hand-testing this endpoint from Vercel: Google
    // intermittently serves an HTML anti-scraping page instead of JSON, and the block clears again
    // within tens of minutes — not a permanent per-library or per-IP ban. A network-level throw
    // from interestOverTime itself is a different failure mode and is NOT retried here; neither is
    // a successfully-parsed-but-empty result (that's a legitimate "no data for this keyword",
    // checked in phase 5) — only "response wasn't valid JSON" gets retried.
    const RETRY_DELAYS_MS = [3000, 8000]; // a rate-limit window clears slower than a network blip,
    // so these are deliberately longer than a typical retry backoff.
    let parsed;
    let lastParseErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let rawResponse;
      try {
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - 90 * 24 * 60 * 60 * 1000);
        rawResponse = await googleTrends.interestOverTime({ keyword, startTime, endTime });
      } catch (err) {
        console.error('[trends-score] phase=fetch-trends', keyword, err?.message, err?.stack);
        return res.status(502).json({ trend_score: null, error: true, message: `Google Trends request failed: ${String(err?.message || err).slice(0, 300)}` });
      }

      try {
        parsed = JSON.parse(rawResponse);
        lastParseErr = null;
        break;
      } catch (err) {
        lastParseErr = err;
        console.error(
          `[trends-score] phase=parse-json attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1}`,
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
      return res.status(502).json({
        trend_score: null,
        error: true,
        message: `Google Trends returned an unparseable response after ${RETRY_DELAYS_MS.length + 1} attempts: ${String(lastParseErr?.message || lastParseErr).slice(0, 300)}`,
      });
    }

    // Phase 5: extract and normalize the timeline series.
    let series;
    try {
      const timelineData = parsed?.default?.timelineData;
      if (!Array.isArray(timelineData) || timelineData.length === 0) {
        console.error('[trends-score] phase=extract-series empty timelineData, keyword=', keyword, 'parsed=', JSON.stringify(parsed).slice(0, 300));
        return res.status(502).json({ trend_score: null, error: true, message: 'Google Trends returned no data for this keyword' });
      }
      series = timelineData.map((point) => ({
        date: point.formattedTime || null,
        timestamp: point.time ? Number(point.time) * 1000 : null,
        value: Array.isArray(point.value) ? Number(point.value[0]) : Number(point.value),
        is_partial: !!point.isPartial,
      }));
    } catch (err) {
      console.error('[trends-score] phase=extract-series', keyword, err?.message, err?.stack);
      return res.status(502).json({ trend_score: null, error: true, message: `Could not read the Trends series: ${String(err?.message || err).slice(0, 300)}` });
    }

    // Phase 6: compute the three deltas and the weighted trend_score.
    let deltas, trendScore, scoreMessage;
    try {
      // Today's point (if present) is usually isPartial: true — an in-progress day whose value is
      // artificially low simply because the day isn't over yet. Included in the raw `series` output
      // for transparency, but excluded from delta math so it doesn't manufacture a fake dip.
      const completeValues = series.filter((p) => !p.is_partial).map((p) => p.value);

      const d90 = halfSplitDelta(completeValues, 90);
      const d30 = halfSplitDelta(completeValues.slice(-30), 30);
      const d7 = halfSplitDelta(completeValues.slice(-7), 7);
      deltas = { d90, d30, d7 };

      if (d90.delta_pct !== null && d30.delta_pct !== null && d7.delta_pct !== null) {
        trendScore = round2(d90.delta_pct * 0.2 + d30.delta_pct * 0.3 + d7.delta_pct * 0.5);
        scoreMessage = null;
      } else {
        // Not an upstream failure — the call succeeded and all raw data below is genuine — just not
        // enough clean signal to honestly compute the weighted score. Still error: false: this is a
        // legitimate outcome for a low-volume keyword, not a broken request.
        trendScore = null;
        scoreMessage = 'trend_score not computed: one or more windows had a zero baseline or too few data points (see deltas for detail).';
      }
    } catch (err) {
      console.error('[trends-score] phase=compute-deltas', keyword, err?.message, err?.stack);
      return res.status(500).json({ trend_score: null, error: true, message: `Could not compute deltas: ${String(err?.message || err).slice(0, 300)}` });
    }

    return res.status(200).json({
      keyword,
      trend_score: trendScore,
      error: false,
      message: scoreMessage,
      deltas,
      raw: {
        series,
        points_count: series.length,
      },
    });
  } catch (err) {
    console.error('[trends-score] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ trend_score: null, error: true, message: `Server error: ${String(err?.message || err).slice(0, 300)}` });
  }
}
