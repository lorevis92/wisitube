// Scene media generation — extracted verbatim from StoryboardStep.jsx (pure refactor, see that
// file's git history for the original inline versions). No behavior change: same prompt-builder
// choice per provider, same concurrency pool for premium engines, same strictly-serial/staggered
// path for Pollinations/Kokoro, same Supabase Storage backup, same cost-ledger writes.
//
// Every generation step reports through `onProgress` rather than touching React state directly, so
// this module has no framework dependency — StoryboardStep.jsx translates each event into its own
// updateImage/updateScene/setProgressMsg calls (see handleProgress there), and a future headless
// caller (the automation engine, Phase 2) can ignore onProgress entirely and just await the
// returned data.
//
// onProgress event shapes:
//   { kind: 'beat', sceneId, beatIndex, patch }  — same shape as StoryboardStep's updateImage(sceneId, beatIndex, patch)
//   { kind: 'scene', sceneId, patch }            — same shape as StoryboardStep's updateScene(sceneId, patch)
//   { kind: 'message', text }                    — same shape as StoryboardStep's setProgressMsg(text)
import { STYLES, loadImage, decodeAudio } from './pollinations';
import { generateSpeech, onLoadProgress, isModelWarm } from './tts';
import { acquireWakeLock, releaseWakeLock } from './wakeLock';
import { recordImageTime, recordAudioTime } from './estimator';
import { generateImage, generateAudio, runWithConcurrency, MAX_PAID_CONCURRENCY } from './sceneOrchestrator';
import { buildTelegraphicPrompt, buildNaturalLanguagePrompt } from './promptBuilders';
import { recordCost } from './db';
import { uploadMedia } from './mediaStorage';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function buildImagePrompt(beat, { project, settings }) {
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
    const { imageUrl, costUsd } = await generateImage(buildImagePrompt(beat, { project, settings }), provider, referenceImages, {
      ...dims,
      seed,
      quality: 'medium',
    });
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
      const storagePath = await uploadMedia(userId, videoId, 'scene-image', beat.id, imageBlob);
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
      const { audioUrl: remoteUrl, costUsd } = await generateAudio(scene.narration, settings.voice, { language: settings.language });
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
      const storagePath = await uploadMedia(userId, videoId, 'scene-audio', scene.id, audioBlob);
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
 * Generates every pending media item (narration + both image beats) for a single scene, and
 * returns the fully updated scene object — the interactive UI doesn't call this directly (it uses
 * generateBeatImage/generateSceneAudio individually so status dots update as each item finishes),
 * but a headless caller (no onProgress) can just await the return value. sceneIndex is accepted for
 * callers that want to label progress/log messages by position; this function's own logic doesn't
 * depend on it.
 */
export async function generateSceneMedia(scene, sceneIndex, { settings, project, channelId, userId, videoId, onProgress } = {}) {
  let working = { ...scene, images: scene.images.map((im) => ({ ...im })) };

  const applyAndForward = (evt) => {
    if (evt.kind === 'beat') {
      working = { ...working, images: working.images.map((im, i) => (i === evt.beatIndex ? { ...im, ...evt.patch } : im)) };
    } else if (evt.kind === 'scene') {
      working = { ...working, ...evt.patch };
    }
    onProgress?.(evt);
  };

  if (working.audioStatus !== 'ready') {
    await generateSceneAudio(working, { settings, channelId, userId, videoId, onProgress: applyAndForward });
  }
  for (let b = 0; b < working.images.length; b++) {
    if (working.images[b].status !== 'ready') {
      // eslint-disable-next-line no-await-in-loop
      await generateBeatImage(working, b, { settings, project, channelId, userId, videoId, onProgress: applyAndForward });
    }
  }

  return working;
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
