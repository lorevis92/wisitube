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
// Exported because fullPipelineRecipe.js's resume-attempt bookkeeping needs the same threshold: a
// recovery batch that's still within this cap is a normal "waiting on Google" state, not a failed
// media-phase attempt (see that file's mediaStillInProgress rollback).
export const MAX_RECOVERY_CYCLES = 5;

// api/gemini-batch.js runs as a Serverless Function with maxDuration 60s, and Google's own
// batch status/results endpoints are occasionally slow for a specific job (seconds of queueing on
// their side, not a real problem). The client timeout therefore sits just under that 60s server
// ceiling rather than at the old aggressive 20s — a status/results call that's merely slow must not
// be aborted and retried forever, silently stalling an otherwise-healthy video. A status-check
// timeout is already handled as "leave the entry, re-check next pass" (see resumePendingBatches),
// never as a job failure, so a generous budget here has no downside. Upload is a single image to
// Supabase Storage — a different, genuinely quick operation — so it keeps the tight budget.
const STATUS_TIMEOUT_MS = 55000;
const RESULTS_TIMEOUT_MS = 55000;
const UPLOAD_TIMEOUT_MS = 20000;

// How long a single job may keep getting 503 / "UNAVAILABLE" from Google's status endpoint before
// it's treated as lost and its scenes resubmitted. Deliberately a full hour, not minutes: the
// status endpoint can be down while the underlying generation job runs fine, and giving up early
// means paying to generate the same images a second time (a recovery batch), not just a delay.
// Tracked per-job on the pendingImageBatches entry (unavailableSince / unavailableCount) and kept
// entirely separate from batchRecoveryCycles / resumeAttempts — a 503 is Google being unreachable,
// not a job or a prompt actually failing.
const SERVICE_UNAVAILABLE_GIVE_UP_MS = 60 * 60 * 1000;

// A Google 503 / "UNAVAILABLE" specifically — NOT our own client-side timeout (AbortError), which
// carries no information about Google's health and keeps the existing "just retry next pass" path.
function isServiceUnavailable(err) {
  if (err?.name === 'AbortError') return false;
  if (Number(err?.httpStatus) === 503) return true;
  return /\b503\b|unavailable/i.test(String(err?.message || err || ''));
}

// Immutably patch one pendingImageBatches entry (matched by jobId).
function updateBatchEntry(project, jobId, fields) {
  return {
    ...project,
    pendingImageBatches: (project.pendingImageBatches || []).map((e) => (e.jobId === jobId ? { ...e, ...fields } : e)),
  };
}

// Recompute project.googleServiceIssue { since, retryCount } from whichever pending entries still
// carry a 503 clock. A { resubmittedAt } marker is left in place here — only a clean status check
// (Google answering again) clears that, in the loop below.
function withServiceIssueFromEntries(project) {
  const affected = (project.pendingImageBatches || []).filter((e) => e.unavailableSince);
  if (affected.length > 0) {
    const since = Math.min(...affected.map((e) => e.unavailableSince));
    const retryCount = Math.max(...affected.map((e) => Number(e.unavailableCount) || 0));
    return { ...project, googleServiceIssue: { since, retryCount } };
  }
  if (project.googleServiceIssue?.resubmittedAt || !project.googleServiceIssue) return project;
  const next = { ...project };
  delete next.googleServiceIssue;
  return next;
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType || 'image/jpeg' });
}

// A genuine Promise.race against a timer — not just a signal the callee has to check — so this
// caps the wait even for calls with no real cancellation support (uploadMedia/Supabase Storage has
// no abort-signal param). For fetch-based calls, the same AbortController is also handed to `fn`,
// so those get real cancellation (the underlying HTTP request actually stops) on top of the race.
// This is what stops one slow/stuck job from blocking every job after it in the sequential loop
// below — the previous version of this file had no timeout here at all.
function withTimeout(fn, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const err = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
      err.name = 'AbortError';
      reject(err);
    });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.race([fn(controller.signal), timeoutPromise]).finally(() => clearTimeout(timer));
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

// Beats that are neither ready NOR the responsibility of any job still actually in flight — i.e.
// genuinely never attempted (or whose job already failed and was already removed from
// pendingImageBatches above), as opposed to "still waiting on a slow job that might yet succeed".
// A scene claimed by a still-pending job is skipped even if its beats aren't ready yet: preempting
// it with a duplicate recovery submission while the original might still come through would just
// waste a batch job and a recovery-cycle count for nothing. This is what lets gap-filling run
// without waiting for every pending job to finish — only for the ones that are still each
// individually accounted for by an in-flight job.
function collectTrulyMissingBeats(project) {
  const claimedSceneIds = new Set();
  (project.pendingImageBatches || []).forEach((entry) => (entry.chunkSceneIds || []).forEach((id) => claimedSceneIds.add(id)));

  const missing = [];
  (project.scenes || []).forEach((s) => {
    if (claimedSceneIds.has(s.id)) return;
    (s.images || []).forEach((im, beatIndex) => {
      if (im.status !== 'ready') missing.push({ sceneId: s.id, beatIndex });
    });
  });
  return missing;
}

async function fetchBatchStatus(jobId) {
  return withTimeout(async (signal) => {
    const res = await fetch('/api/gemini-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', jobId }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || (typeof data.error === 'string' ? data.error : '') || `Batch status check failed (HTTP ${res.status})`);
      // api/gemini-batch.js's status action passes Google's HTTP status straight through as
      // data.status on an error — used by isServiceUnavailable to tell a real 503 from anything else.
      err.httpStatus = Number(data.status) || res.status;
      throw err;
    }
    return data;
  }, STATUS_TIMEOUT_MS, 'Batch status check');
}

async function fetchBatchResultsFor(jobId) {
  return withTimeout(async (signal) => {
    const res = await fetch('/api/gemini-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'results', jobId }),
      signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || 'Batch results fetch failed');
    return Array.isArray(data.results) ? data.results : [];
  }, RESULTS_TIMEOUT_MS, 'Batch results fetch');
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
          storagePath = await withTimeout(
            () => uploadMedia(userId, videoId, 'scene-image', `${sceneId}-${beatIndex}`, blob),
            UPLOAD_TIMEOUT_MS,
            'Storage upload'
          );
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

  // TEMPORARY diagnostic (remove once the "0 images ready after 24h" report is root-caused) — logs
  // the exact pendingImageBatches content this call is about to process, so it can be read straight
  // from the browser console instead of guessed at.
  console.warn('[resume-batch] START', pending.length, JSON.parse(JSON.stringify(pending)));

  // Jobs given up on this pass after a full hour of 503s — the resubmit + user-facing marker are
  // applied after the completeness check below (which is what actually re-queues their scenes).
  const serviceGiveUps = [];

  for (const entry of pending) {
    let status;
    try {
      // eslint-disable-next-line no-await-in-loop
      status = await fetchBatchStatus(entry.jobId);
      // TEMPORARY diagnostic — the real state Google reports for this specific job, right now.
      console.warn('[resume-batch] job status', entry.jobId, status.state, status.googleState);
    } catch (err) {
      if (isServiceUnavailable(err)) {
        const since = entry.unavailableSince || Date.now();
        const count = (Number(entry.unavailableCount) || 0) + 1;
        const elapsedMs = Date.now() - since;
        const minutes = Math.round(elapsedMs / 60000);

        if (elapsedMs < SERVICE_UNAVAILABLE_GIVE_UP_MS) {
          // Still inside the patient window — record the per-job consecutive-503 clock and wait.
          // Never touches beats or batchRecoveryCycles: Google being unreachable is not a job failure.
          current = updateBatchEntry(current, entry.jobId, { unavailableSince: since, unavailableCount: count });
          current = withServiceIssueFromEntries(current);
          // eslint-disable-next-line no-await-in-loop
          await persist?.(current);
          onProgress?.({
            kind: 'message',
            text: `Google's batch service is unavailable for job ${entry.jobId} (503, retry ${count}, ${minutes}m so far) — holding off; we keep retrying for up to an hour before resubmitting, to avoid paying twice for the same images.`,
          });
          continue;
        }

        // An hour of solid 503s on the STATUS endpoint. Before writing the job off, try the RESULTS
        // endpoint directly — it's a separate Google endpoint and may be healthy even while status
        // isn't, which would mean the images are already generated and paid for: nothing to resubmit.
        onProgress?.({
          kind: 'message',
          text: `Job ${entry.jobId} has been unreachable for over an hour — trying a direct results fetch before writing it off.`,
        });
        let salvaged = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          salvaged = await fetchBatchResultsFor(entry.jobId);
        } catch (resErr) {
          console.error('[batchResumption] last-ditch results fetch also failed for', entry.jobId, resErr);
        }
        if (Array.isArray(salvaged) && salvaged.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          current = await applyBatchResults(current, salvaged, {
            userId,
            videoId,
            channelId,
            resolution: entry.resolution || resolution,
            onProgress,
          });
          current = { ...current, pendingImageBatches: current.pendingImageBatches.filter((e) => e.jobId !== entry.jobId) };
          current = withServiceIssueFromEntries(current);
          // eslint-disable-next-line no-await-in-loop
          await persist?.(current);
          onProgress?.({
            kind: 'message',
            text: `Recovered job ${entry.jobId} straight from its results despite the status outage — no resubmission and no extra cost.`,
          });
          continue;
        }

        // Genuinely lost. Drop the entry (leave its beats un-ready, NOT errored) so the completeness
        // check below resubmits them through the normal recovery path — which respects
        // MAX_RECOVERY_CYCLES and the spend that implies. The user-facing marker/message is applied
        // after that check, once we know whether a recovery batch actually went out.
        current = { ...current, pendingImageBatches: current.pendingImageBatches.filter((e) => e.jobId !== entry.jobId) };
        serviceGiveUps.push({ jobId: entry.jobId, since, retryCount: count });
        // eslint-disable-next-line no-await-in-loop
        await persist?.(current);
        continue;
      }

      // Any OTHER status-check failure (our own timeout, transient network): unchanged — no counter,
      // no beats touched, just re-check next pass. The recipe's mediaStillInProgress rollback keeps
      // this from counting against resumeAttempts while the job stays outstanding.
      console.error('[batchResumption] status check failed for', entry.jobId, err);
      onProgress?.({ kind: 'message', text: `Could not check batch ${entry.jobId} yet (${String(err.message || err)}) — will retry` });
      continue;
    }

    // A real status came back — Google IS answering for this job. Clear any 503 clock it carried
    // and, if nothing is in an outage anymore, drop the whole service-issue banner (including a
    // resubmitted marker — Google is fully back).
    if (entry.unavailableSince || entry.unavailableCount || current.googleServiceIssue) {
      current = updateBatchEntry(current, entry.jobId, { unavailableSince: null, unavailableCount: 0 });
      const stillOutage = (current.pendingImageBatches || []).some((e) => e.unavailableSince);
      if (!stillOutage && current.googleServiceIssue) {
        current = { ...current };
        delete current.googleServiceIssue;
      }
      // eslint-disable-next-line no-await-in-loop
      await persist?.(current);
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
  //
  // Deliberately NOT gated on every pending job having been accounted for — a video with, say, one
  // slow/stuck job left in pendingImageBatches must not block noticing and resubmitting scenes that
  // were never claimed by ANY job at all (a chunk that failed to submit — see
  // geminiBatchImageEngine.js — or was simply never included). collectTrulyMissingBeats already
  // excludes anything still claimed by an in-flight job, so this is safe to run every time.
  const cyclesBeforeCompleteness = Number(current.batchRecoveryCycles) || 0;
  const wasBatchInvolved = pending.length > 0 || cyclesBeforeCompleteness > 0;
  if (wasBatchInvolved) {
    const missing = collectTrulyMissingBeats(current);
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

  // A job (or more than one) was written off this pass after its full hour of 503s. Record the
  // user-facing marker now that the completeness check above has had its chance to re-queue the
  // affected scenes — resubmittedAt is only set if a recovery batch actually went out (Google might
  // still be refusing submits too, or the recovery cap may be spent).
  if (serviceGiveUps.length > 0) {
    const since = Math.min(...serviceGiveUps.map((g) => g.since));
    const retryCount = Math.max(...serviceGiveUps.map((g) => g.retryCount));
    const resubmitted = (Number(current.batchRecoveryCycles) || 0) > cyclesBeforeCompleteness;
    const recoveryExhausted = cyclesBeforeCompleteness >= MAX_RECOVERY_CYCLES;
    if (!recoveryExhausted) {
      // Not stuck yet — keep the reassuring banner, now flipped to the "we resubmitted" variant
      // once a recovery batch actually went out.
      current = {
        ...current,
        googleServiceIssue: resubmitted ? { since, retryCount, resubmittedAt: Date.now() } : { since, retryCount },
      };
      await persist?.(current);
    }
    onProgress?.({
      kind: 'message',
      text: recoveryExhausted
        ? `${serviceGiveUps.length} job(s) written off after more than an hour of Google 503s, but the recovery limit is already spent — needs manual regeneration.`
        : resubmitted
        ? `${serviceGiveUps.length} job(s) written off after more than an hour of Google 503s — the affected scenes have been resubmitted as a fresh batch.`
        : `${serviceGiveUps.length} job(s) written off after more than an hour of Google 503s — couldn't resubmit yet, will retry.`,
    });
  }

  // TEMPORARY diagnostic (remove once root-caused) — confirms this function actually reached its
  // end (as opposed to the caller giving up/navigating away mid-run) and what it ended with.
  const readyCount = (current.scenes || []).reduce((n, s) => n + (s.images || []).filter((im) => im.status === 'ready').length, 0);
  const totalCount = (current.scenes || []).reduce((n, s) => n + (s.images || []).length, 0);
  console.warn('[resume-batch] END', { readyCount, totalCount, stillPending: (current.pendingImageBatches || []).length });

  return current;
}
