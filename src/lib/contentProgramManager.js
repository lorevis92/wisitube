// WisiTube — Content Program Manager orchestration, shared by ChannelDashboardStep.jsx's manual
// panel and the automation recipes (fullPipelineRecipe.js/staticBackgroundRecipe.js). Both used to
// call api/program-manager.js independently, each keeping its own idea of "what's suggested next"
// — this file makes them read and write the SAME cached list (channel.topic_scoring_cache), so a
// video the automation starts from a suggestion disappears from the dashboard too, and vice versa.
//
// The full pipeline, run at most once every 24h per channel (see isTopicCacheFresh):
//   Stage A — api/program-manager.js proposes a broad (14) purely qualitative candidate batch.
//   Stage B — api/topic-scoring.js scores every candidate against real Trends/YouTube data.
//   Stage C — api/program-manager.js (mode=synthesize) selects and ranks the final 6-8, combining
//             its own editorial judgment with the real numbers.
// Between full passes, "Start this video"/"Not interested" pull a replacement from the already-
// scored batch (free — no new Trends/YouTube/Claude-research calls) rather than re-running A-C.
import { saveChannel, listPendingPromises } from './db';
import { listChannelPlaylists } from './youtubePublishEngine';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Within the 12-15 range the feature calls for — a single fixed number keeps api/program-manager.js's
// existing `count` param usable as-is, no need for a "12-15" range string.
const CANDIDATE_BATCH_SIZE = 14;

// Reads the raw body via response.text() before parsing — never assumes a response is JSON just
// because one was requested. A platform-level failure (most relevantly: this endpoint's own
// maxDuration killing the request, which Vercel reports as a 504 with an HTML/plain-text body, not
// JSON) would otherwise surface as a bare, context-free "Unexpected token '<'" SyntaxError from
// res.json() itself. Throwing a message with the HTTP status and the first 150 chars of the actual
// body instead means fetchSuggestions' catch (ChannelDashboardStep.jsx) — and the automation
// recipes' own error logging — show something a person can actually act on.
async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[contentProgramManager] non-JSON response from', url, 'status=', res.status, 'body=', rawText.slice(0, 300));
    throw new Error(`${url} returned a non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 150) || '(empty body)'}`);
  }
  return { ok: res.ok, data };
}

const normalizeTitle = (t) => (t || '').toLowerCase().trim();

export function isTopicCacheFresh(channel) {
  if (!channel?.topic_scoring_cached_at) return false;
  return Date.now() - new Date(channel.topic_scoring_cached_at).getTime() < CACHE_TTL_MS;
}

// ---- Stage A: broad qualitative batch ----
async function runStageA({ channel, videos, existingPlaylists, pendingPromises, refinementText }) {
  const { ok, data } = await postJSON('/api/program-manager', {
    channelName: channel.name,
    niche: channel.niche || '',
    editorialNotes: channel.editorialNotes || '',
    existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
    refinement: refinementText || '',
    creativeOverride: channel.prompt_overrides?.programManager || null,
    activeDirective: channel.automation_directive || '',
    existingPlaylists,
    pendingPromises,
    avoidTitles: channel.dismissed_suggestions || [],
    count: CANDIDATE_BATCH_SIZE,
  });
  if (!ok) throw new Error(data.error || 'Content Program Manager request failed');
  const candidates = Array.isArray(data.suggestions) ? data.suggestions : [];
  if (!candidates.length) throw new Error('Content Program Manager returned no suggestions');
  return { analysis: data.analysis || '', candidates };
}

// ---- Stage B: real Trends/YouTube scoring ----
async function runStageB(channelId, candidates) {
  const { ok, data } = await postJSON('/api/topic-scoring', {
    channelId,
    candidateTopics: candidates.map((c) => c.title),
  });
  if (!ok || data.error) throw new Error(data.message || 'Topic scoring request failed');
  const byTitle = new Map((data.results || []).map((r) => [normalizeTitle(r.topic), r]));
  return candidates.map((c) => {
    const scored = byTitle.get(normalizeTitle(c.title));
    return {
      ...c,
      score: scored ? scored.score : null,
      signal_incomplete: scored ? scored.signal_incomplete : true,
      reasoning: scored?.reasoning || 'No scoring data available for this candidate.',
      trends: scored?.trends || null,
      competition: scored?.competition || null,
    };
  });
}

// ---- Stage C: synthesis — select and rank the final shortlist ----
async function runStageC({ channel, analysis, scoredCandidates }) {
  const { ok, data } = await postJSON('/api/program-manager', {
    mode: 'synthesize',
    channelName: channel.name,
    niche: channel.niche || '',
    editorialNotes: channel.editorialNotes || '',
    activeDirective: channel.automation_directive || '',
    creativeOverride: channel.prompt_overrides?.programManager || null,
    analysis,
    scoredCandidates: scoredCandidates.map((c) => ({
      title: c.title,
      angle: c.angle || '',
      series: c.series || null,
      priority: c.priority || 'medium',
      fulfills_promise_video_id: c.fulfills_promise_video_id || null,
      score: c.score,
      signal_incomplete: !!c.signal_incomplete,
      reasoning: c.reasoning || '',
    })),
  });
  if (!ok) throw new Error(data.error || 'Suggestion synthesis request failed');
  const finalList = Array.isArray(data.finalSuggestions) ? data.finalSuggestions : [];
  if (!finalList.length) throw new Error('Synthesis returned no final suggestions');

  // Merges Claude's { title, priority, rationale } back onto the matching scored candidate so the
  // final list carries its full real data (score/reasoning/raw trends+competition), not just what
  // the synthesis call itself echoed back. A title Claude fails to match verbatim (shouldn't
  // normally happen — the schema instructs it to copy the title exactly) still degrades gracefully
  // rather than being dropped: it's kept, just without the real-data fields it can't be matched to.
  return finalList.map((f) => {
    const match = scoredCandidates.find((c) => normalizeTitle(c.title) === normalizeTitle(f.title));
    return {
      ...(match || { title: f.title, angle: '', series: null, fulfills_promise_video_id: null, score: null, signal_incomplete: true, reasoning: 'Could not match this suggestion back to a scored candidate.', trends: null, competition: null }),
      title: f.title || match?.title,
      priority: f.priority || match?.priority || 'medium',
      rationale: f.rationale || '',
    };
  });
}

/**
 * Runs the full cached A-B-C pipeline, or returns the cached result unchanged if it's less than
 * 24h old. `videos` is this channel's existing video list (for stage A's context). Pass
 * `forceRefresh: true` or a non-empty `refinementText` to bypass the cache and run a fresh pass —
 * a refinement always needs new reasoning, so it implies forceRefresh.
 * Returns { channel, analysis, finalSuggestions } — `channel` is the freshly-saved record when a
 * new pass ran, or the same object passed in when the cache was used as-is.
 */
export async function getTopicSuggestions(channel, { videos = [], forceRefresh = false, refinementText = '' } = {}) {
  if (!forceRefresh && !refinementText && channel.topic_scoring_cache && isTopicCacheFresh(channel)) {
    const cache = channel.topic_scoring_cache;
    return { channel, analysis: cache.analysis || '', finalSuggestions: cache.finalSuggestions || [] };
  }

  // Enrichment, not required — both already swallow their own failures and return [] rather than
  // throwing, so neither blocks the pipeline on its own.
  const existingPlaylists = await listChannelPlaylists(channel).catch(() => []);
  const pendingPromises = await listPendingPromises(channel.id).catch((err) => {
    console.error('[contentProgramManager] failed to load pending promises', err);
    return [];
  });

  const { analysis, candidates } = await runStageA({ channel, videos, existingPlaylists, pendingPromises, refinementText });
  const scoredCandidates = await runStageB(channel.id, candidates);
  const finalSuggestions = await runStageC({ channel, analysis, scoredCandidates });

  const topic_scoring_cache = {
    analysis,
    finalSuggestions,
    scoredCandidates,
    usedTitles: finalSuggestions.map((s) => s.title).filter(Boolean),
    generatedAt: Date.now(),
  };
  const updated = await saveChannel({ ...channel, topic_scoring_cache, topic_scoring_cached_at: new Date().toISOString() });
  return { channel: updated, analysis, finalSuggestions };
}

// Best-scoring candidate from the cached batch that hasn't already been shown (usedTitles) or
// explicitly dismissed — the "cheap" backfill path, no new Trends/YouTube/Claude-research calls.
function pickNextCandidate(scoredCandidates, avoidTitlesLower) {
  const eligible = (scoredCandidates || []).filter((c) => c.title && !avoidTitlesLower.has(normalizeTitle(c.title)));
  eligible.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return eligible[0] || null;
}

// Only reached once the cached scored batch is fully exhausted — a single lightweight Claude call
// for one more idea, deliberately NOT re-running Trends/YouTube scoring (that's the whole point of
// this fallback existing separately from the full A-C pipeline). The result is marked
// signal_incomplete so the UI never implies it's backed by real data it was never given.
async function fetchFallbackSuggestion(channel, videos, avoidTitles) {
  const existingPlaylists = await listChannelPlaylists(channel).catch(() => []);
  const pendingPromises = await listPendingPromises(channel.id).catch(() => []);
  const { ok, data } = await postJSON('/api/program-manager', {
    channelName: channel.name,
    niche: channel.niche || '',
    editorialNotes: channel.editorialNotes || '',
    existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
    creativeOverride: channel.prompt_overrides?.programManager || null,
    activeDirective: channel.automation_directive || '',
    existingPlaylists,
    pendingPromises,
    count: 1,
    avoidTitles,
  });
  if (!ok) throw new Error(data.error || 'Failed to fetch a fallback suggestion');
  const s = (data.suggestions || [])[0];
  if (!s) return null;
  return {
    ...s,
    score: null,
    signal_incomplete: true,
    reasoning: 'Fallback idea — Trends/YouTube data was not re-queried for this suggestion.',
    trends: null,
    competition: null,
    rationale: null,
  };
}

// Shared by startTopicSuggestion/dismissTopicSuggestion below: removes `suggestion` from the
// cached finalSuggestions, tops the list back up from the scored pool (or, failing that, one cheap
// fallback idea), and persists the result. `channel` should already reflect any caller-side change
// (e.g. dismissTopicSuggestion appending to dismissed_suggestions) before this runs.
async function removeAndBackfill(channel, suggestion, videos) {
  const cache = channel.topic_scoring_cache;
  if (!cache) return channel; // nothing cached yet — shouldn't normally happen; no-op rather than throw
  let finalSuggestions = (cache.finalSuggestions || []).filter((s) => normalizeTitle(s.title) !== normalizeTitle(suggestion.title));
  let usedTitles = cache.usedTitles || [];

  const avoidSet = new Set([...usedTitles, ...(channel.dismissed_suggestions || [])].map(normalizeTitle));
  const replacement = pickNextCandidate(cache.scoredCandidates || [], avoidSet);
  if (replacement) {
    finalSuggestions = [...finalSuggestions, replacement];
    usedTitles = [...usedTitles, replacement.title];
  } else {
    try {
      const avoidTitles = [...usedTitles, ...(channel.dismissed_suggestions || []), ...finalSuggestions.map((s) => s.title)];
      const fallback = await fetchFallbackSuggestion(channel, videos, avoidTitles);
      if (fallback) {
        finalSuggestions = [...finalSuggestions, fallback];
        usedTitles = [...usedTitles, fallback.title];
      }
    } catch (err) {
      // Best-effort — the list just stays one item shorter if even the fallback fails.
      console.error('[contentProgramManager] fallback suggestion fetch failed', err);
    }
  }

  const updatedCache = { ...cache, finalSuggestions, usedTitles };
  return saveChannel({ ...channel, topic_scoring_cache: updatedCache });
}

// "Start this video" — dashboard (ChannelDashboardStep.jsx) and automation (fullPipelineRecipe.js/
// staticBackgroundRecipe.js) both call this the moment a suggestion is turned into a real video, so
// it disappears from the shared list for both surfaces immediately.
export async function startTopicSuggestion(channel, suggestion, videos) {
  return removeAndBackfill(channel, suggestion, videos);
}

// "Not interested" — same removal/backfill mechanics, plus remembering the title so it never
// resurfaces in a future full regeneration or fallback pick either (dismissed_suggestions, capped
// at the most recent 50 by whoever appends to it — same convention as before this refactor).
export async function dismissTopicSuggestion(channel, suggestion, videos) {
  const dismissed_suggestions = [...(channel.dismissed_suggestions || []), suggestion.title].filter(Boolean).slice(-50);
  return removeAndBackfill({ ...channel, dismissed_suggestions }, suggestion, videos);
}
