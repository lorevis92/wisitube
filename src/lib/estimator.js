// Rough, self-improving time estimates for the Create→Storyboard flow. Image/voice generation
// times are learned per-browser (localStorage moving average) rather than hardcoded, since they
// vary a lot with the user's machine and network.

const SCENE_COUNTS = { short: 10, medium: 16, long: 24 };
// Claude now runs web searches to ground the character bible in real appearances before writing
// the script, so the initial /api/generate round-trip takes noticeably longer than a plain
// text-only completion — these bases reflect that added research time.
const SCRIPT_BASE_S = { short: 45, medium: 75, long: 120 };
const IMAGE_BEATS_PER_SCENE = 2;
const MAX_SAMPLES = 20;
const DEFAULT_IMAGE_S = 4;
const DEFAULT_AUDIO_S = 7;
const IMAGE_KEY = 'wisitube_avg_image_s';
const AUDIO_KEY = 'wisitube_avg_audio_s';

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

export function estimateSceneCount(length) {
  return SCENE_COUNTS[length] || SCENE_COUNTS.short;
}

export function estimateTotalSeconds({ length, modelWarm }) {
  const sceneCount = estimateSceneCount(length);
  const avgImage = getAvgImageTime();
  const avgAudio = getAvgAudioTime();
  const scriptBase = SCRIPT_BASE_S[length] || SCRIPT_BASE_S.short;
  return scriptBase + sceneCount * IMAGE_BEATS_PER_SCENE * (avgImage + 1.5) + sceneCount * avgAudio + (modelWarm ? 0 : 90);
}

export function estimateRemainingSeconds(scenes, modelWarm) {
  const avgImage = getAvgImageTime();
  const avgAudio = getAvgAudioTime();
  let total = 0;
  let hasAudioToGenerate = false;
  for (const s of scenes || []) {
    const images = Array.isArray(s.images) ? s.images : [];
    for (const im of images) {
      if (im.status !== 'ready') total += avgImage + 1.5;
    }
    if (s.audioStatus !== 'ready') {
      total += avgAudio;
      hasAudioToGenerate = true;
    }
  }
  if (!modelWarm && hasAudioToGenerate) total += 90;
  return total;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}
