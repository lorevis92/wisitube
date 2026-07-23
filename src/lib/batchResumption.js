// Picks up whatever Gemini Batch jobs a video's project.pendingImageBatches says are in flight —
// the "resume" half of the batch persistence story (src/lib/geminiBatchImageEngine.js is the
// "submit" half). Called whenever a video that might have pending batches is opened, so reopening
// the app hours later (or after a crash) always reflects the freshest state Gemini actually has,
// never whatever was on screen the moment the tab closed.
//
// Framework-agnostic like every other engine module here: reports through onProgress rather than
// touching React state directly, and never calls saveVideo itself — persist(project) is injected
// by the caller (App.jsx for the manual/Storyboard path) and awaited after every single job this
// function resolves, one at a time, not batched at the end — a job that's already been resolved and
// removed from pendingImageBatches must not go unpersisted just because a *later* job in the same
// call then fails to process.
import { uploadMedia } from './mediaStorage';
import { recordCost } from './db';
import { NANOBANANA_BATCH_PRICES } from './imageProviders';
import { parseBeatKey, collectPendingBeatItems, submitImageBatchChunk } from './geminiBatchImageEngine';

// Safety ceiling on point 3's auto-regeneration loop — if a beat's prompt is systematically
// rejected by Gemini (or anything else keeps producing a non-ready beat), this stops after this
// many recovery batches rather than resubmitting it forever. Tracked on project.batchRecoveryCycles
// so the count survives across separate resumePendingBatches calls (e.g. across app reopens).
const MAX_RECOVERY_CYCLES = 5;

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType || 'image/jpeg' });
}

// Same per-beat patch shape mediaGenerationEngine.js's onProgress events use, applied immutably —
// project.scenes[...].images[...] is never mutated in place, only replaced.
function applyBeatPatch(project, sceneId, beatIndex, patch) {
  return {
    ...project,
    scenes: project.scenes.map((s) =>
      s.id === sceneId ? { ...s, images: s.images.map((im, i) => (i === beatIndex ? { ...im, ...patch } : im)) } : s
    ),
  };
}

function collectMissingBeats(project) {
  const missing = [];
  (project.scenes || []).forEach((s) => {
    (s.images || []).forEach((im, beatIndex) => {
      if (im.status !== 'ready') missing.push({ sceneId: s.id, beatIndex });
    });
  });
  return missing;
}

async function fetchBatchStatus(jobId) {
  const res = await fetch('/api/gemini-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', jobId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.error || 'Batch status check failed');
  return data;
}

async function fetchBatchResultsFor(jobId) {
  const res = await fetch('/api/gemini-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'results', jobId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.error || 'Batch results fetch failed');
  return Array.isArray(data.results) ? data.results : [];
}

// Downloads one succeeded job's results and applies each one to the given beat — ready + uploaded
// to Storage on success, 'error' on a per-item failure (see api/gemini-batch.js's results action:
// a job can succeed overall while individual items still failed). Storage upload failure doesn't
// downgrade the beat from ready — same "never blocks on backup" convention as
// mediaGenerationEngine.js's generateBeatImage/generateSceneAudio. Every successfully downloaded
// image records its cost against the channel, same pattern (recordCost) every other image provider
// already uses — resolution comes from the job's own pendingImageBatches entry, not a guess.
async function applyBatchResults(project, results, { userId, videoId, channelId, resolution, onProgress }) {
  let current = project;
  const costPerImage = NANOBANANA_BATCH_PRICES[resolution] ?? NANOBANANA_BATCH_PRICES['0.5K'];

  for (const r of results) {
    const parsed = parseBeatKey(r.id);
    if (!parsed) {
      console.error('[batchResumption] could not parse a beat key out of result id', r.id);
      continue;
    }
    const { sceneId, beatIndex } = parsed;

    if (r.imageBase64 && !r.error) {
      try {
        const blob = base64ToBlob(r.imageBase64, r.mimeType);
        const url = URL.createObjectURL(blob);
        let storagePath = null;
        let backupFailed = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          storagePath = await uploadMedia(userId, videoId, 'scene-image', `${sceneId}-${beatIndex}`, blob);
        } catch (err) {
          console.error('[batchResumption] storage upload failed', sceneId, beatIndex, err);
          backupFailed = true;
        }
        if (costPerImage > 0 && channelId) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await recordCost({ channelId, videoId, provider: 'nanobanana-batch', type: 'image', amountUsd: costPerImage });
          } catch (err) {
            console.error('[batchResumption] recordCost failed', sceneId, beatIndex, err);
          }
        }
        const patch = { status: 'ready', url, blob, storagePath, backupFailed };
        current = applyBeatPatch(current, sceneId, beatIndex, patch);
        onProgress?.({ kind: 'beat', sceneId, beatIndex, patch });
      } catch (err) {
        console.error('[batchResumption] failed to process a result image', sceneId, beatIndex, err);
        current = applyBeatPatch(current, sceneId, beatIndex, { status: 'error' });
        onProgress?.({ kind: 'beat', sceneId, beatIndex, patch: { status: 'error' } });
      }
    } else {
      // Per-item failure — r.error/r.errorDetail carry whatever Gemini said, but this function's
      // job is just to mark the beat as needing regeneration; point 3's completeness check below
      // is what actually retries it.
      current = applyBeatPatch(current, sceneId, beatIndex, { status: 'error' });
      onProgress?.({ kind: 'beat', sceneId, beatIndex, patch: { status: 'error' } });
    }
  }
  return current;
}

/**
 * project: the full project object (scenes, pendingImageBatches, characterBible, references…) —
 * same shape App.jsx/fullPipelineRecipe.js already pass around.
 * userId/videoId: needed for Supabase Storage paths (uploadMedia) — not part of `project` itself.
 * channelId: needed for recordCost — every image downloaded from a succeeded batch records its
 * cost against this channel, same pattern every other image provider already uses.
 * settings: needed only if a completeness-driven recovery batch has to be submitted (buildImagePrompt).
 * resolution: used for any recovery batch this call submits — defaults to '0.5K', same default as
 * the rest of the batch mechanism.
 * onProgress({ kind: 'beat', sceneId, beatIndex, patch }): per-beat updates, same shape
 * mediaGenerationEngine.js already uses.
 * onProgress({ kind: 'message', text }): coarse status text.
 * persist(project): injected by the caller — awaited after every job this function resolves (and
 * after a recovery batch is submitted), so nothing here is ever left unpersisted for more than one
 * job's worth of work.
 *
 * Returns the final, fully-updated project. A project with no pendingImageBatches at all resolves
 * immediately as a no-op (still worth calling unconditionally on every video open — see App.jsx).
 */
export async function resumePendingBatches(project, { userId, videoId, channelId, settings, resolution = '0.5K', onProgress, persist } = {}) {
  let current = project;
  const pending = Array.isArray(current.pendingImageBatches) ? current.pendingImageBatches : [];

  for (const entry of pending) {
    let status;
    try {
      // eslint-disable-next-line no-await-in-loop
      status = await fetchBatchStatus(entry.jobId);
    } catch (err) {
      console.error('[batchResumption] status check failed for', entry.jobId, err);
      onProgress?.({ kind: 'message', text: `Could not check batch ${entry.jobId}: ${String(err.message || err)}` });
      continue; // leave this entry exactly as-is — re-checked on the next resume
    }

    if (status.state === 'succeeded') {
      let results;
      try {
        // eslint-disable-next-line no-await-in-loop
        results = await fetchBatchResultsFor(entry.jobId);
      } catch (err) {
        console.error('[batchResumption] results fetch failed for', entry.jobId, err);
        onProgress?.({ kind: 'message', text: `Could not fetch results for batch ${entry.jobId}: ${String(err.message || err)}` });
        continue; // leave the entry as succeeded-but-unprocessed — retried on the next resume
      }

      // eslint-disable-next-line no-await-in-loop
      current = await applyBatchResults(current, results, { userId, videoId, channelId, resolution: entry.resolution || resolution, onProgress });
      current = { ...current, pendingImageBatches: current.pendingImageBatches.filter((e) => e.jobId !== entry.jobId) };
      // eslint-disable-next-line no-await-in-loop
      await persist?.(current);
    } else if (status.state === 'failed') {
      // Job-level failure — every beat this job was ever going to produce is marked for
      // regeneration; point 3's completeness check below is what actually resubmits them.
      for (const sceneId of entry.chunkSceneIds || []) {
        const scene = current.scenes.find((s) => s.id === sceneId);
        if (!scene) continue;
        scene.images.forEach((im, beatIndex) => {
          if (im.status !== 'ready') {
            current = applyBeatPatch(current, sceneId, beatIndex, { status: 'error' });
            onProgress?.({ kind: 'beat', sceneId, beatIndex, patch: { status: 'error' } });
          }
        });
      }
      current = { ...current, pendingImageBatches: current.pendingImageBatches.filter((e) => e.jobId !== entry.jobId) };
      // eslint-disable-next-line no-await-in-loop
      await persist?.(current);
    }
    // 'pending' / 'processing' / an 'unknown: …' state: left untouched, re-checked next time this
    // function runs — an unrecognized state is not treated as a failure (see api/gemini-batch.js).
  }

  // Point 3 — completeness verification with auto-regeneration. Gated on this video actually
  // having been touched by the batch mechanism at some point (entries processed this call, or a
  // recovery cycle already in progress from an earlier call) — NOT just "any beat isn't ready",
  // which would otherwise fire for every ordinary video generated through the regular
  // pollinations/nanobanana/gptimage pipeline (StoryboardStep already has its own regeneration UI
  // for those; this recovery loop is only for beats a batch job was actually responsible for).
  // Also only runs once every currently known job has been accounted for (no point submitting a
  // recovery batch for a beat whose job might still succeed a moment from now).
  const stillPending = (current.pendingImageBatches || []).length > 0;
  const wasBatchInvolved = pending.length > 0 || (Number(current.batchRecoveryCycles) || 0) > 0;
  if (!stillPending && wasBatchInvolved) {
    const missing = collectMissingBeats(current);
    if (missing.length > 0) {
      const cycles = Number(current.batchRecoveryCycles) || 0;
      if (cycles >= MAX_RECOVERY_CYCLES) {
        for (const { sceneId, beatIndex } of missing) {
          const patch = { status: 'error', error: `Gave up after ${MAX_RECOVERY_CYCLES} batch recovery attempts — regenerate manually` };
          current = applyBeatPatch(current, sceneId, beatIndex, patch);
          onProgress?.({ kind: 'beat', sceneId, beatIndex, patch });
        }
        onProgress?.({ kind: 'message', text: `${missing.length} beat(s) still missing after ${MAX_RECOVERY_CYCLES} recovery attempts — needs manual regeneration` });
        await persist?.(current);
      } else {
        const missingSceneIds = [...new Set(missing.map((m) => m.sceneId))];
        const items = collectPendingBeatItems(current, missingSceneIds, settings || {});
        if (items.length) {
          try {
            const jobId = await submitImageBatchChunk(items, resolution);
            const pendingEntry = { jobId, chunkSceneIds: missingSceneIds, resolution, submittedAt: Date.now(), status: 'pending' };
            current = {
              ...current,
              pendingImageBatches: [...(current.pendingImageBatches || []), pendingEntry],
              batchRecoveryCycles: cycles + 1,
            };
            onProgress?.({ kind: 'message', text: `Recovery batch ${cycles + 1}/${MAX_RECOVERY_CYCLES} submitted for ${items.length} missing beat(s)` });
            await persist?.(current);
          } catch (err) {
            console.error('[batchResumption] recovery batch submit failed', err);
            onProgress?.({ kind: 'message', text: `Recovery batch submit failed: ${String(err.message || err)}` });
            // Not persisted — batchRecoveryCycles isn't incremented either, since nothing was
            // actually submitted; the next resume will try again without burning a cycle for it.
          }
        }
      }
    }
  }

  return current;
}
