// Gemini Batch API image-generation submission — the "send work" half of the batch persistence
// story; src/lib/batchResumption.js is the "pick work back up" half. Framework-agnostic, same
// "onProgress instead of touching state directly" shape as mediaGenerationEngine.js: this module
// never calls saveVideo itself — the caller applies each onProgress event to its own project copy
// and persists it, immediately, in response to each event. That immediacy is the whole point: if
// the browser closes partway through submitting a video's chunks, whichever jobIds had already come
// back must already be saved, so batchResumption.js can pick them up later — the rest simply never
// got submitted yet.
//
// Wired into fullPipelineRecipe.js's media phase when channel.automation_image_provider is
// 'nanobanana-batch' — see that file for how audio generation (unrelated to which image provider
// is configured) still runs through the existing synchronous mediaGenerationEngine.js path.
import { buildImagePrompt } from './mediaGenerationEngine';
import { runWithConcurrency } from './sceneOrchestrator';
import { isCreditExhaustedMessage } from './providerErrors';

// Scenes per submitted batch job, not beats — matches pendingImageBatches' own `chunkSceneIds`
// field (scene-level, not beat-level). Each scene contributes up to 2 items (its 2 image beats),
// so a chunk of 10 scenes is up to 20 Gemini requests per job — comfortably small for a single
// inline batchGenerateContent call.
export const BATCH_CHUNK_SCENES = 10;

// Deliberately its own (lower) constant, not sceneOrchestrator.js's MAX_PAID_CONCURRENCY — a
// 120-scene video firing 6 concurrent submit requests within the same ~1s window is exactly the
// burst that trips a per-second rate limit on Gemini's batch submission endpoint (confirmed live:
// only the chunks caught in that first burst that happened to land inside the quota went through,
// the rest failed silently — see the retry/backoff and stagger below, both new). Submission is a
// single quick request per chunk (the job itself then runs on Google's side for hours), so a lower
// concurrency here costs a few extra seconds of total submit time, not generation time.
const MAX_BATCH_SUBMIT_CONCURRENCY = 2;
// Spacing between one worker's successive submissions, on top of the lower concurrency above —
// further smooths out bursts hitting the submission endpoint at the same instant.
const SUBMIT_STAGGER_MIN_MS = 500;
const SUBMIT_STAGGER_MAX_MS = 1000;
// 2 retries, 5s then 15s — same backoff shape as mediaGenerationEngine.js's network-error retry,
// but gated on looking like a rate limit specifically (see isRateLimitError below), not any error:
// a real application error (bad prompt, invalid argument) won't resolve itself by retrying.
const SUBMIT_RETRY_DELAYS_MS = [5000, 15000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const staggerDelay = () => SUBMIT_STAGGER_MIN_MS + Math.random() * (SUBMIT_STAGGER_MAX_MS - SUBMIT_STAGGER_MIN_MS);

// Recognizes a rate-limit/quota rejection from Gemini's submission endpoint — HTTP 429, or a
// message mentioning rate/quota (Google's own wording for this varies; this catches both an exact
// status and the common phrasing without assuming one specific error shape).
function isRateLimitError(err) {
  // A recognized "billing/quota exhausted" failure is NOT a transient rate limit — retrying it 5s
  // later just burns two more 402s. api/gemini-batch.js already classified it; trust that.
  if (isCreditExhaustedMessage(err?.message)) return false;
  if (err?.status === 429) return true;
  return /rate|quota/i.test(String(err?.message || ''));
}

// A beat's Gemini Batch item id/metadata.key — encodes both the scene and beat index so a result
// can be routed back to the exact beat it belongs to, verified against the real API in
// AutomationStep.jsx's test panel (metadata.key round-trips correctly).
export function beatKey(sceneId, beatIndex) {
  return `${sceneId}:${beatIndex}`;
}

// Converts sceneId to a number HERE, once, rather than leaving it as the string every caller would
// otherwise get from key.slice() — project.scenes[].id is always a plain number (see
// fullPipelineRecipe.js's sceneIdCounter), and comparing that with a string sceneId via === always
// fails silently (no match, no error): every consumer of a beat key looked like it worked while
// never actually writing anything back to a scene. Converting at the source means a future new
// consumer can't reintroduce the same bug by forgetting to convert at its own call site.
export function parseBeatKey(key) {
  if (typeof key !== 'string') return null;
  const sep = key.lastIndexOf(':');
  if (sep === -1) {
    console.error('[geminiBatchImageEngine] parseBeatKey: no ":" separator found', key);
    return null;
  }
  const rawSceneId = key.slice(0, sep);
  const sceneId = Number(rawSceneId);
  const beatIndex = Number(key.slice(sep + 1));
  if (!rawSceneId || Number.isNaN(sceneId) || Number.isNaN(beatIndex)) {
    console.error('[geminiBatchImageEngine] parseBeatKey: sceneId or beatIndex not numeric', key);
    return null;
  }
  return { sceneId, beatIndex };
}

// Known limitation: batch items are text-only prompts (see the submit call below) — a beat
// anchored to a reference photo has no way to carry that photo into a Gemini Batch request the way
// mediaGenerationEngine.js's generateBeatImage does for the interactive providers. buildImagePrompt
// still produces a reasonable prompt for such a beat (falling back to whatever text it has), but
// without the reference photo actually anchoring the result — a real gap, not silently "handled".
// Exported so batchResumption.js's completeness-driven recovery batch can build items the same way
// instead of duplicating this.
export function collectPendingBeatItems(project, sceneIds, settings) {
  const items = [];
  const sceneIdSet = new Set(sceneIds);
  (project.scenes || []).forEach((scene) => {
    if (!sceneIdSet.has(scene.id)) return;
    (scene.images || []).forEach((beat, beatIndex) => {
      if (beat.status === 'ready') return;
      items.push({ id: beatKey(scene.id, beatIndex), prompt: buildImagePrompt(beat, { project, settings }) });
    });
  });
  return items;
}

// Groups the ids of every scene that still has at least one non-ready image beat into chunks of
// BATCH_CHUNK_SCENES — scenes with nothing pending are skipped entirely (no point sending an empty
// or already-satisfied chunk).
function chunkScenesNeedingImages(scenes, chunkSize) {
  const pendingSceneIds = (scenes || [])
    .filter((s) => (s.images || []).some((im) => im.status !== 'ready'))
    .map((s) => s.id);

  const chunks = [];
  for (let i = 0; i < pendingSceneIds.length; i += chunkSize) {
    chunks.push(pendingSceneIds.slice(i, i + chunkSize));
  }
  return chunks;
}

// Thin wrapper over api/gemini-batch.js's submit action — throws on failure so callers decide how
// to handle a submission that never went out at all (nothing to persist in that case). The thrown
// error carries `.status` (Gemini's own HTTP status when api/gemini-batch.js passed one through) so
// callers can recognize a rate limit (429) specifically, not just "something failed".
export async function submitImageBatchChunk(items, resolution) {
  const res = await fetch('/api/gemini-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', items, resolution }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.detail || data.error || 'Batch submit failed');
    err.status = data.status || res.status;
    throw err;
  }
  if (!data.jobId) throw new Error('Batch submit did not return a jobId');
  return data.jobId;
}

// Retries a chunk submission when the failure looks like a rate limit — 2 retries, 5s then 15s —
// and gives up immediately (no retry) for anything else, since a real application error (an
// invalid prompt, say) won't resolve itself by trying again. onRetry(attempt, totalAttempts, err)
// fires before each wait, for the caller to surface it.
async function submitImageBatchChunkWithRetry(items, resolution, onRetry) {
  const totalAttempts = SUBMIT_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await submitImageBatchChunk(items, resolution);
    } catch (err) {
      if (attempt > SUBMIT_RETRY_DELAYS_MS.length || !isRateLimitError(err)) throw err;
      const delay = SUBMIT_RETRY_DELAYS_MS[attempt - 1];
      onRetry?.(attempt + 1, totalAttempts, err);
      await sleep(delay);
    }
  }
}

/**
 * Submits every pending image beat in `project` as a set of Gemini Batch jobs, chunked by scene —
 * submitted with bounded concurrency (MAX_BATCH_SUBMIT_CONCURRENCY workers, each pausing between
 * its own successive submissions) rather than either fully sequential or fully parallel — both
 * extremes either take unnecessarily long or burst the submission endpoint's rate limit. Submission
 * itself is a single quick request per chunk (the job then runs on Google's side for up to hours).
 *
 * channelId/videoId/logStep: a chunk that exhausts its retries and fails to submit is logged via
 * logStep with status 'error' — a submission that never went out is otherwise invisible anywhere
 * except a browser console nobody may be watching, which is exactly the gap that caused 70 of 120
 * scenes on one video to silently never be attempted.
 *
 * onProgress({ kind: 'batch-submitted', pendingEntry }): fired the instant a chunk's submit call
 * returns a jobId — possibly from several concurrent workers in close succession. The caller MUST
 * append pendingEntry to its own project.pendingImageBatches and persist (saveVideo) in response —
 * synchronously appending (safe: JS callbacks never interleave mid-execution) but the actual
 * network persist call should be queued/serialized by the caller (e.g. a simple promise chain) so
 * two concurrent saveVideo calls for the same video can't finish out of order and silently drop an
 * already-appended entry. That's what gives the "never lost" guarantee this module exists for.
 * onProgress({ kind: 'message', text }): coarse progress text (chunk X/Y submitted, retry notices).
 *
 * Does not itself know whether persistence succeeded — that's the caller's responsibility, same as
 * every other engine module in this codebase.
 */
export async function generateAllMediaViaBatch(project, { settings, channelId, videoId, resolution = '0.5K', onProgress, logStep } = {}) {
  const chunks = chunkScenesNeedingImages(project.scenes, BATCH_CHUNK_SCENES)
    .map((chunkSceneIds) => ({ chunkSceneIds, items: collectPendingBeatItems(project, chunkSceneIds, settings) }))
    .filter((c) => c.items.length > 0); // every beat in an empty chunk was already ready by the time we got here

  let submitted = 0;
  await runWithConcurrency(chunks, MAX_BATCH_SUBMIT_CONCURRENCY, async ({ chunkSceneIds, items }) => {
    let jobId;
    try {
      jobId = await submitImageBatchChunkWithRetry(items, resolution, (attempt, total, err) =>
        onProgress?.({ kind: 'message', text: `Batch submit retry ${attempt}/${total} after rate limit: ${String(err.message || err)}` })
      );
    } catch (err) {
      const creditExhausted = isCreditExhaustedMessage(err?.message);
      const message = creditExhausted
        ? `${err.message} (batch chunk not submitted — scenes: ${chunkSceneIds.join(', ')})`
        : `Batch chunk failed to submit (scenes: ${chunkSceneIds.join(', ')}): ${String(err.message || err)}`;
      console.error('[geminiBatchImageEngine] chunk submit failed', chunkSceneIds, err);
      onProgress?.({ kind: 'message', text: message });
      // This is the one place a failed submission used to vanish without a persisted trace — the
      // scenes in this chunk stay non-ready with nothing on the record showing they were ever
      // attempted. logStep makes the failure show up in the automation log even if nobody was
      // watching the live view at the time; batchResumption.js's completeness check (independent of
      // whether other jobs are still pending — see that file) is what actually retries it later.
      await logStep?.(channelId, videoId, 'media', creditExhausted ? 'credit_exhausted' : 'error', message)?.catch(() => {});
      await sleep(staggerDelay());
      return;
    }

    onProgress?.({
      kind: 'batch-submitted',
      pendingEntry: { jobId, chunkSceneIds, resolution, submittedAt: Date.now(), status: 'pending' },
    });
    submitted++;
    onProgress?.({ kind: 'message', text: `Submitted ${submitted}/${chunks.length} batch chunks…` });
    await sleep(staggerDelay());
  });
}
