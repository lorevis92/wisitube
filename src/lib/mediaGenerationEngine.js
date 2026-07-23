// Scene media generation — extracted verbatim from StoryboardStep.jsx (pure refactor, see that
// file's git history for the original inline versions). No behavior change: same prompt-builder
// choice per provider, same concurrency pool for premium engines, same strictly-serial/staggered
// path for Pollinations/Kokoro, same Supabase Storage backup, same cost-ledger writes.
//
// Every generation step reports through `onProgress` rather than touching React state directly, so
// this module has no framework dependency — StoryboardStep.jsx translates each event into its own
// updateImage/updateScene/setProgressMsg calls (see handleProgress there), and the headless
// automation recipe (fullPipelineRecipe.js) reduces the same events into its own local project copy
// instead of ignoring them, since it needs the final per-item status to persist progress and detect
// partial failures.
//
// onProgress event shapes:
//   { kind: 'beat', sceneId, beatIndex, patch }  — same shape as StoryboardStep's updateImage(sceneId, beatIndex, patch)
//   { kind: 'scene', sceneId, patch }            — same shape as StoryboardStep's updateScene(sceneId, patch)
//   { kind: 'message', text }                    — same shape as StoryboardStep's setProgressMsg(text)
//   { kind: 'retry', message }                   — a network-error retry is about to happen (see
//                                                   withNetworkRetry below); runFullPipeline turns
//                                                   this into a logStep(..., 'retrying', ...) row,
//                                                   the interactive UI just ignores it (no dedicated
//                                                   handling in StoryboardStep.jsx yet)
import { STYLES, loadImage, decodeAudio } from './pollinations';
import { generateSpeech, onLoadProgress, isModelWarm } from './tts';
import { acquireWakeLock, releaseWakeLock } from './wakeLock';
import { recordImageTime, recordAudioTime } from './estimator';
import { generateImage, generateAudio, runWithConcurrency, MAX_PAID_CONCURRENCY } from './sceneOrchestrator';
import { buildTelegraphicPrompt, buildNaturalLanguagePrompt } from './promptBuilders';
import { recordCost } from './db';
import { uploadMedia } from './mediaStorage';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENERATION_TIMEOUT_MS = 45000;
const UPLOAD_TIMEOUT_MS = 20000;
// Two retries beyond the first attempt, at 5s then 15s — matches the automation resilience spec.
const NETWORK_RETRY_DELAYS_MS = [5000, 15000];

// A failure that means the request never really got an answer from the server — dropped Wi-Fi, a
// DNS lookup that failed, or this file's own timeout below giving up on waiting — as opposed to an
// application error (400/403 from a provider), where the server DID respond and retrying would
// just repeat the same rejection.
function isNetworkError(err) {
  if (err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '');
  return /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK/i.test(msg);
}

// Races fn(signal) against a timer that aborts it. fn isn't required to honor the signal (e.g.
// uploadMedia has no signal support) — even then this stops WAITING after timeoutMs so the caller
// can retry or give up, rather than hanging forever on a connection that will never resolve.
function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return fn(controller.signal)
    .catch((err) => {
      if (timedOut) {
        const timeoutErr = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
        timeoutErr.name = 'AbortError';
        throw timeoutErr;
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Wraps a single network call (image/audio generation, Storage upload) with a timeout and a
 * retry-with-backoff — but ONLY retries when the failure looks like a network problem (see
 * isNetworkError above). An application error (bad request, provider rejection) is never retried:
 * it isn't going to resolve itself. onRetry(attempt, totalAttempts, err), if given, fires right
 * before each wait so the caller can surface "retrying" somewhere (see the onProgress 'retry'
 * event this module's callers emit).
 */
async function withNetworkRetry(fn, timeoutMs, onRetry) {
  const totalAttempts = NETWORK_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (err) {
      if (attempt > NETWORK_RETRY_DELAYS_MS.length || !isNetworkError(err)) throw err;
      const delay = NETWORK_RETRY_DELAYS_MS[attempt - 1];
      onRetry?.(attempt + 1, totalAttempts, err);
      await sleep(delay);
    }
  }
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Reference photos (a real face) always win over the text-only character bible for the same
// beat — the bible's traits are appended only when there's no active photo anchoring this beat.
// Pollinations gets the compact, telegraphic style (its model needs unambiguous fragments);
// Nano Banana 2 / GPT Image 2 get full natural-language sentences, with the character's name
// used as an explicit semantic anchor when one applies.
// Exported so src/lib/geminiBatchImageEngine.js can build the same prompt for a batch-submitted
// beat instead of duplicating the character-bible/style logic.
export function buildImagePrompt(beat, { project, settings }) {
  const hasReference = !!(beat.referenceId && (project.references || []).some((r) => r.id === beat.referenceId));
  let character = null;
  let traits = '';
  if (beat.characterId && !hasReference) {
    character = (project.characterBible || []).find((c) => c.id === beat.characterId);
    const variant = character && (character.variants || []).find((v) => v.label === beat.variantLabel);
    traits = [character?.baseDescription, variant?.description].filter(Boolean).join(', ');
  }

  const style = STYLES[settings.style];
  const provider = settings.imageProvider || 'pollinations';

  if (provider === 'pollinations') {
    return buildTelegraphicPrompt({ scenePrompt: beat.prompt, styleSuffix: style.suffix, characterTraits: traits });
  }
  return buildNaturalLanguagePrompt({ scenePrompt: beat.prompt, styleDescription: style.natural, characterName: character?.name, characterTraits: traits });
}

/**
 * Regenerates a single image beat. `scene` must be the beat's owning scene (as looked up by the
 * caller — same as StoryboardStep's genImage used to do via project.scenes.find). Returns
 * true/false for success/failure; all state changes are reported through onProgress.
 */
export async function generateBeatImage(scene, beatIndex, { settings, project, channelId, userId, videoId, newSeed = false, onProgress } = {}) {
  const beat = scene.images[beatIndex];
  const seed = newSeed ? Math.floor(Math.random() * 999999) : beat.seed;
  const reference = beat.referenceId ? (project.references || []).find((r) => r.id === beat.referenceId) : null;
  const provider = settings.imageProvider || 'pollinations';
  const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };

  onProgress?.({ kind: 'beat', sceneId: scene.id, beatIndex, patch: { status: 'loading', seed, backupFailed: false } });
  const startedAt = performance.now();
  try {
    // Reference photos flow to every provider the same way now — nanobanana/gptimage take them
    // natively as referenceImages, same principle already used for Pollinations kontext.
    const referenceImages = reference ? [await blobToDataUri(reference.file)] : [];
    const imagePrompt = buildImagePrompt(beat, { project, settings });
    const { imageUrl, costUsd } = await withNetworkRetry(
      (signal) => generateImage(imagePrompt, provider, referenceImages, { ...dims, seed, quality: 'medium' }, signal),
      GENERATION_TIMEOUT_MS,
      (attempt, total, err) =>
        onProgress?.({ kind: 'retry', message: `Image generation retry ${attempt}/${total} after network error: ${err.message}` })
    );
    // Real spend only — Pollinations always returns costUsd: 0, so nothing gets logged for it.
    if (costUsd > 0) await recordCost({ channelId, videoId, provider, type: 'image', amountUsd: costUsd });
    await loadImage(imageUrl);
    // Keep the raw bytes so the project survives without the remote URL (persistence, offline).
    const imageBlob = await (await fetch(imageUrl)).blob();
    const objectUrl = URL.createObjectURL(imageBlob);
    recordImageTime((performance.now() - startedAt) / 1000);
    onProgress?.({ kind: 'beat', sceneId: scene.id, beatIndex, patch: { status: 'ready', url: objectUrl, blob: imageBlob } });

    // Back up to Supabase Storage so this survives a refresh — never blocks the generation
    // itself: the Blob set above is already usable this session regardless of whether this
    // succeeds.
    try {
      console.log('[storage-upload] attempting', {
        userId,
        videoId,
        kind: 'scene-image',
        beatId: beat.id,
        blobSize: imageBlob?.size,
        blobType: imageBlob?.type,
      });
      const storagePath = await withNetworkRetry(
        () => uploadMedia(userId, videoId, 'scene-image', beat.id, imageBlob),
        UPLOAD_TIMEOUT_MS,
        (attempt, total, err) =>
          onProgress?.({ kind: 'retry', message: `Storage upload retry ${attempt}/${total} after network error: ${err.message}` })
      );
      onProgress?.({ kind: 'beat', sceneId: scene.id, beatIndex, patch: { storagePath, backupFailed: false } });
    } catch (err) {
      console.error('[storage-upload] FAILED', err.message, err);
      onProgress?.({ kind: 'beat', sceneId: scene.id, beatIndex, patch: { backupFailed: true } });
    }

    return true;
  } catch {
    onProgress?.({ kind: 'beat', sceneId: scene.id, beatIndex, patch: { status: 'error' } });
    return false;
  }
}

/**
 * Regenerates a scene's narration audio. Returns true/false for success/failure; all state
 * changes are reported through onProgress.
 */
export async function generateSceneAudio(scene, { settings, channelId, userId, videoId, onProgress } = {}) {
  onProgress?.({ kind: 'scene', sceneId: scene.id, patch: { audioStatus: 'loading', audioError: null, audioBackupFailed: false } });
  const startedAt = performance.now();
  const voiceEngine = settings.voiceEngine || 'kokoro';
  const wasWarmBefore = isModelWarm();
  try {
    let audioBlob;
    if (voiceEngine === 'minimax') {
      const { audioUrl: remoteUrl, costUsd } = await withNetworkRetry(
        (signal) => generateAudio(scene.narration, settings.voice, { language: settings.language }, signal),
        GENERATION_TIMEOUT_MS,
        (attempt, total, err) =>
          onProgress?.({ kind: 'retry', message: `Audio generation retry ${attempt}/${total} after network error: ${err.message}` })
      );
      if (costUsd > 0) await recordCost({ channelId, videoId, provider: 'minimax', type: 'audio', amountUsd: costUsd });
      audioBlob = await (await fetch(remoteUrl)).blob();
    } else {
      audioBlob = await generateSpeech(scene.narration, settings.voice);
    }
    const audioUrl = URL.createObjectURL(audioBlob);
    const buffer = await decodeAudio(audioUrl);
    // Skip the sample if this call paid the one-time model download/load cost — that's
    // accounted for separately (the +90s term), and would otherwise wreck the moving average.
    // MiniMax has no such warm-up cost, so its timings always count.
    if (voiceEngine === 'minimax' || wasWarmBefore) recordAudioTime((performance.now() - startedAt) / 1000);
    onProgress?.({
      kind: 'scene',
      sceneId: scene.id,
      patch: { audioStatus: 'ready', audioUrl, audioBlob, audioDuration: buffer.duration, audioError: null },
    });

    // Back up to Supabase Storage so this survives a refresh — never blocks the generation
    // itself: the Blob set above is already usable this session regardless of whether this
    // succeeds.
    try {
      console.log('[storage-upload] attempting', {
        userId,
        videoId,
        kind: 'scene-audio',
        beatId: scene.id,
        blobSize: audioBlob?.size,
        blobType: audioBlob?.type,
      });
      const storagePath = await withNetworkRetry(
        () => uploadMedia(userId, videoId, 'scene-audio', scene.id, audioBlob),
        UPLOAD_TIMEOUT_MS,
        (attempt, total, err) =>
          onProgress?.({ kind: 'retry', message: `Storage upload retry ${attempt}/${total} after network error: ${err.message}` })
      );
      onProgress?.({ kind: 'scene', sceneId: scene.id, patch: { audioStoragePath: storagePath, audioBackupFailed: false } });
    } catch (err) {
      console.error('[storage-upload] FAILED', err.message, err);
      onProgress?.({ kind: 'scene', sceneId: scene.id, patch: { audioBackupFailed: true } });
    }

    return true;
  } catch (e) {
    onProgress?.({ kind: 'scene', sceneId: scene.id, patch: { audioStatus: 'error', audioError: e?.message || String(e) } });
    return false;
  }
}

/**
 * Generates every pending media item across the whole project — the "Generate all/missing" button.
 * Same phased approach as before: narration first (concurrent pool for MiniMax, strictly serial for
 * Kokoro's single local worker), then images (concurrent pool for premium providers, serial with a
 * 1.5s stagger for Pollinations' free tier). Acquires/releases the wake lock for the duration.
 */
export async function generateAllMedia(project, { settings, channelId, userId, videoId, onProgress } = {}) {
  await acquireWakeLock();
  const voiceEngine = settings.voiceEngine || 'kokoro';
  const imageProvider = settings.imageProvider || 'pollinations';

  const unsubscribe = onLoadProgress((info) => {
    if (info.status === 'progress') {
      onProgress?.({ kind: 'message', text: `Downloading voice model (~90MB, one time)… ${Math.round(info.progress)}%` });
    }
  });

  try {
    // Phase 1: voiceover for every scene that still needs it. MiniMax is a paid cloud call, so
    // it goes through the shared concurrency pool exactly like paid images below; Kokoro stays
    // exactly as before — strictly serial, since it's a single local Web Worker.
    const pendingAudioScenes = project.scenes.filter((s) => s.audioStatus !== 'ready');
    if (voiceEngine === 'minimax') {
      let done = 0;
      await runWithConcurrency(pendingAudioScenes, MAX_PAID_CONCURRENCY, async (scene) => {
        await generateSceneAudio(scene, { settings, channelId, userId, videoId, onProgress });
        done++;
        onProgress?.({ kind: 'message', text: `Voice ${done}/${pendingAudioScenes.length}…` });
      });
    } else {
      for (let i = 0; i < pendingAudioScenes.length; i++) {
        onProgress?.({ kind: 'message', text: `Voice ${i + 1}/${pendingAudioScenes.length}…` });
        // eslint-disable-next-line no-await-in-loop
        await generateSceneAudio(pendingAudioScenes[i], { settings, channelId, userId, videoId, onProgress });
      }
    }

    // Phase 2: images for every beat that still needs one. Paid providers (nanobanana/gptimage)
    // go through the same pool; Pollinations keeps its exact prior behavior — strictly serial
    // with a 1.5s stagger between calls, deliberately conservative for the free tier.
    const pendingImageBeats = [];
    project.scenes.forEach((s) =>
      s.images.forEach((im, b) => {
        if (im.status !== 'ready') pendingImageBeats.push({ sceneId: s.id, beatIndex: b });
      })
    );

    if (imageProvider === 'pollinations') {
      for (let i = 0; i < pendingImageBeats.length; i++) {
        if (i > 0) await sleep(1500);
        onProgress?.({ kind: 'message', text: `Image ${i + 1}/${pendingImageBeats.length}…` });
        const { sceneId, beatIndex } = pendingImageBeats[i];
        const scene = project.scenes.find((s) => s.id === sceneId);
        // eslint-disable-next-line no-await-in-loop
        await generateBeatImage(scene, beatIndex, { settings, project, channelId, userId, videoId, onProgress });
      }
    } else {
      let done = 0;
      await runWithConcurrency(pendingImageBeats, MAX_PAID_CONCURRENCY, async ({ sceneId, beatIndex }) => {
        const scene = project.scenes.find((s) => s.id === sceneId);
        await generateBeatImage(scene, beatIndex, { settings, project, channelId, userId, videoId, onProgress });
        done++;
        onProgress?.({ kind: 'message', text: `Image ${done}/${pendingImageBeats.length}…` });
      });
    }
  } finally {
    unsubscribe();
    await releaseWakeLock();
  }

  onProgress?.({ kind: 'message', text: '' });
}
