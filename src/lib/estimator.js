// Rough, self-improving time estimates for the Create→Storyboard flow. Image/voice generation
// times are learned per-browser (localStorage moving average) rather than hardcoded, since they
// vary a lot with the user's machine and network. Script writing now runs as three separate server
// calls (titles → outline → chunked scenes, see api/generate-titles.js / generate-outline.js /
// generate-scenes.js) instead of one big call, so the estimate sums each phase individually.

const IMAGE_BEATS_PER_SCENE = 2;
const MAX_SAMPLES = 20;
const DEFAULT_IMAGE_S = 4;
const DEFAULT_AUDIO_S = 7;
const IMAGE_KEY = 'wisitube_avg_image_s';
const AUDIO_KEY = 'wisitube_avg_audio_s';

export const TITLES_PHASE_S = 12;
export const OUTLINE_PHASE_S = 45;
const SCENES_PER_CHUNK_S = 35; // one api/generate-scenes.js call, ~14-16 scenes
// Matches the server-side per-call cap in api/generate-scenes.js (sceneCount is clamped to 16
// there) — used only to estimate how many chunk calls a video's scene count will need.
const MAX_SCENES_PER_CHUNK = 16;

function loadSamples(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSamples(key, samples) {
  try {
    localStorage.setItem(key, JSON.stringify(samples.slice(-MAX_SAMPLES)));
  } catch {
    /* ignore */
  }
}

function recordTime(key, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const samples = loadSamples(key);
  samples.push(seconds);
  saveSamples(key, samples);
}

function avgTime(key, fallback) {
  const samples = loadSamples(key);
  if (!samples.length) return fallback;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function recordImageTime(seconds) {
  recordTime(IMAGE_KEY, seconds);
}

export function recordAudioTime(seconds) {
  recordTime(AUDIO_KEY, seconds);
}

export function getAvgImageTime() {
  return avgTime(IMAGE_KEY, DEFAULT_IMAGE_S);
}

export function getAvgAudioTime() {
  return avgTime(AUDIO_KEY, DEFAULT_AUDIO_S);
}

// Matches the server-side totalScenes formula in api/generate-outline.js.
export function estimateSceneCount(lengthMinutes) {
  return Math.max(6, Math.round((Number(lengthMinutes) || 0) * 12));
}

// How long the chunked api/generate-scenes.js calls alone are expected to take for a video of
// this length — split out so screens shown before scene-writing starts (e.g. TitleSelectStep's
// outline loader) can subtract it from the full estimate instead of promising work not yet begun.
export function estimateScenesChunkSeconds(lengthMinutes) {
  const sceneCount = estimateSceneCount(lengthMinutes);
  const chunkCount = Math.max(1, Math.ceil(sceneCount / MAX_SCENES_PER_CHUNK));
  return chunkCount * SCENES_PER_CHUNK_S;
}

// Both functions below return { syncSeconds, imageEta } rather than a plain number of seconds.
// Image generation time is only ever learned from the synchronous providers (recordImageTime is
// called from mediaGenerationEngine.js's generateBeatImage, which nanobanana-batch videos skip
// entirely via skipImages) — summing that learned average into a single second-scale total for a
// provider that actually submits jobs Google can take minutes to hours to resolve produced a
// number that looked precise but was fiction. syncSeconds is everything this module can actually
// estimate on a seconds/minutes scale (script writing, audio, and — for every non-batch provider —
// images too); imageEta is null unless the image provider is 'nanobanana-batch', in which case it's
// the qualitative string 'minutes-to-hours' and the image time is deliberately left OUT of
// syncSeconds — callers must show the two separately, never add them together.
function batchImageEta(imageProvider, hasImagesToGenerate) {
  return imageProvider === 'nanobanana-batch' && hasImagesToGenerate ? 'minutes-to-hours' : null;
}

export function estimateTotalSeconds({ lengthMinutes, modelWarm, imageProvider }) {
  const sceneCount = estimateSceneCount(lengthMinutes);
  const avgImage = getAvgImageTime();
  const avgAudio = getAvgAudioTime();
  const scriptPhasesS = TITLES_PHASE_S + OUTLINE_PHASE_S + estimateScenesChunkSeconds(lengthMinutes);
  const isBatch = imageProvider === 'nanobanana-batch';
  const imageSeconds = isBatch ? 0 : sceneCount * IMAGE_BEATS_PER_SCENE * (avgImage + 1.5);
  const syncSeconds = scriptPhasesS + imageSeconds + sceneCount * avgAudio + (modelWarm ? 0 : 90);
  return { syncSeconds, imageEta: batchImageEta(imageProvider, sceneCount > 0) };
}

export function estimateRemainingSeconds(scenes, modelWarm, imageProvider) {
  const avgImage = getAvgImageTime();
  const avgAudio = getAvgAudioTime();
  const isBatch = imageProvider === 'nanobanana-batch';
  let syncSeconds = 0;
  let hasAudioToGenerate = false;
  let hasImagesToGenerate = false;
  for (const s of scenes || []) {
    const images = Array.isArray(s.images) ? s.images : [];
    for (const im of images) {
      if (im.status !== 'ready') {
        hasImagesToGenerate = true;
        if (!isBatch) syncSeconds += avgImage + 1.5;
      }
    }
    if (s.audioStatus !== 'ready') {
      syncSeconds += avgAudio;
      hasAudioToGenerate = true;
    }
  }
  if (!modelWarm && hasAudioToGenerate) syncSeconds += 90;
  return { syncSeconds, imageEta: batchImageEta(imageProvider, hasImagesToGenerate) };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}
