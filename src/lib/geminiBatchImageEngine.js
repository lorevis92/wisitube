// Gemini Batch API image-generation submission — the "send work" half of the batch persistence
// story; src/lib/batchResumption.js is the "pick work back up" half. Framework-agnostic, same
// "onProgress instead of touching state directly" shape as mediaGenerationEngine.js: this module
// never calls saveVideo itself — the caller applies each onProgress event to its own project copy
// and persists it, immediately, before moving on. That immediacy is the whole point: if the browser
// closes after 3 of 10 chunks have been submitted, those 3 jobIds must already be saved so
// batchResumption.js can pick them up later — the other 7 simply never got submitted yet.
//
// NOT wired into fullPipelineRecipe.js's active media phase yet — that phase still generates
// images via mediaGenerationEngine.js's generateAllMedia (pollinations/nanobanana/gptimage/
// minimax). This module exists as complete, correct, callable infrastructure for when the Gemini
// Batch path is actually connected to a generation flow.
import { buildImagePrompt } from './mediaGenerationEngine';

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
 * Submits every pending image beat in `project` as a sequence of Gemini Batch jobs, chunked by
 * scene. Awaits each submission before starting the next chunk — so if this is interrupted
 * (browser closed, tab navigated away) after N chunks, only those N have actually gone out, and
 * only those N should exist in the caller's persisted pendingImageBatches.
 *
 * onProgress({ kind: 'batch-submitted', pendingEntry }): fired the instant a chunk's submit call
 * returns a jobId — the caller MUST append pendingEntry to its own project.pendingImageBatches and
 * persist (saveVideo) synchronously in response to this event, before this function's loop moves
 * on to the next chunk, to get the "never lost" guarantee this module exists for.
 * onProgress({ kind: 'message', text }): coarse progress text (chunk X/Y).
 *
 * Does not itself know whether persistence succeeded — that's the caller's responsibility, same as
 * every other engine module in this codebase.
 */
export async function generateAllMediaViaBatch(project, { settings, resolution = '0.5K', onProgress } = {}) {
  const chunks = chunkScenesNeedingImages(project.scenes, BATCH_CHUNK_SCENES);
  for (let i = 0; i < chunks.length; i++) {
    const chunkSceneIds = chunks[i];
    const items = collectPendingBeatItems(project, chunkSceneIds, settings);
    if (!items.length) continue; // every beat in this chunk was already ready by the time we got here

    onProgress?.({ kind: 'message', text: `Submitting batch ${i + 1}/${chunks.length} (${items.length} image${items.length === 1 ? '' : 's'})…` });

    let jobId;
    try {
      // eslint-disable-next-line no-await-in-loop
      jobId = await submitImageBatchChunk(items, resolution);
    } catch (err) {
      console.error('[geminiBatchImageEngine] chunk submit failed', chunkSceneIds, err);
      onProgress?.({ kind: 'message', text: `Batch ${i + 1}/${chunks.length} failed to submit: ${String(err.message || err)}` });
      continue; // this chunk's beats stay non-ready; a later completeness check will retry them
    }

    onProgress?.({
      kind: 'batch-submitted',
      pendingEntry: { jobId, chunkSceneIds, resolution, submittedAt: Date.now(), status: 'pending' },
    });
  }
}
