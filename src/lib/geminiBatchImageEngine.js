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
import { runWithConcurrency, MAX_PAID_CONCURRENCY } from './sceneOrchestrator';

// Scenes per submitted batch job, not beats — matches pendingImageBatches' own `chunkSceneIds`
// field (scene-level, not beat-level). Each scene contributes up to 2 items (its 2 image beats),
// so a chunk of 10 scenes is up to 20 Gemini requests per job — comfortably small for a single
// inline batchGenerateContent call.
export const BATCH_CHUNK_SCENES = 10;

// A beat's Gemini Batch item id/metadata.key — encodes both the scene and beat index so a result
// can be routed back to the exact beat it belongs to, verified against the real API in
// AutomationStep.jsx's test panel (metadata.key round-trips correctly).
export function beatKey(sceneId, beatIndex) {
  return `${sceneId}:${beatIndex}`;
}

export function parseBeatKey(key) {
  if (typeof key !== 'string') return null;
  const sep = key.lastIndexOf(':');
  if (sep === -1) return null;
  const sceneId = key.slice(0, sep);
  const beatIndex = Number(key.slice(sep + 1));
  if (!sceneId || Number.isNaN(beatIndex)) return null;
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
// to handle a submission that never went out at all (nothing to persist in that case).
export async function submitImageBatchChunk(items, resolution) {
  const res = await fetch('/api/gemini-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', items, resolution }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.error || 'Batch submit failed');
  if (!data.jobId) throw new Error('Batch submit did not return a jobId');
  return data.jobId;
}

/**
 * Submits every pending image beat in `project` as a set of Gemini Batch jobs, chunked by scene —
 * submitted in PARALLEL (same bounded-concurrency pool sceneOrchestrator.js already uses for paid
 * providers, MAX_PAID_CONCURRENCY workers) rather than one chunk waited on before the next starts.
 * Submission itself is a single quick request per chunk (the job then runs on Google's side for up
 * to hours) — there's no reason to serialize those requests, only the persistence reacting to them.
 *
 * onProgress({ kind: 'batch-submitted', pendingEntry }): fired the instant a chunk's submit call
 * returns a jobId — possibly from several concurrent workers in close succession. The caller MUST
 * append pendingEntry to its own project.pendingImageBatches and persist (saveVideo) in response —
 * synchronously appending (safe: JS callbacks never interleave mid-execution) but the actual
 * network persist call should be queued/serialized by the caller (e.g. a simple promise chain) so
 * two concurrent saveVideo calls for the same video can't finish out of order and silently drop an
 * already-appended entry. That's what gives the "never lost" guarantee this module exists for.
 * onProgress({ kind: 'message', text }): coarse progress text (chunk X/Y submitted).
 *
 * Does not itself know whether persistence succeeded — that's the caller's responsibility, same as
 * every other engine module in this codebase.
 */
export async function generateAllMediaViaBatch(project, { settings, resolution = '0.5K', onProgress } = {}) {
  const chunks = chunkScenesNeedingImages(project.scenes, BATCH_CHUNK_SCENES)
    .map((chunkSceneIds) => ({ chunkSceneIds, items: collectPendingBeatItems(project, chunkSceneIds, settings) }))
    .filter((c) => c.items.length > 0); // every beat in an empty chunk was already ready by the time we got here

  let submitted = 0;
  await runWithConcurrency(chunks, MAX_PAID_CONCURRENCY, async ({ chunkSceneIds, items }) => {
    let jobId;
    try {
      jobId = await submitImageBatchChunk(items, resolution);
    } catch (err) {
      console.error('[geminiBatchImageEngine] chunk submit failed', chunkSceneIds, err);
      onProgress?.({ kind: 'message', text: `A batch chunk failed to submit: ${String(err.message || err)}` });
      return; // this chunk's beats stay non-ready; a later completeness check will retry them
    }

    onProgress?.({
      kind: 'batch-submitted',
      pendingEntry: { jobId, chunkSceneIds, resolution, submittedAt: Date.now(), status: 'pending' },
    });
    submitted++;
    onProgress?.({ kind: 'message', text: `Submitted ${submitted}/${chunks.length} batch chunks…` });
  });
}
