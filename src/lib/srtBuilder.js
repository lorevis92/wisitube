// Builds a standard .srt caption file from a project's scenes, reusing the exact per-word timing
// engine.js computes for the on-screen subtitle rendering — so the uploaded captions track always
// lines up with what viewers see on screen, not an independent guess.
import { computeWordTimings, buildBeatTimeline, groupWordsIntoBlocks } from './engine';

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Absolute (timeline-wide) start/end for every narrated word — each scene is divided among its image
// beats by the exact same buildBeatTimeline() call drawSubtitle()/drawScene() render from, so the
// timestamps match frame-for-frame whether a scene carries real narration spans or falls back to an
// even split. full_pipeline only (see buildSrtFromScenes) — static_background has no beats to split.
function collectWordEntries(scenes) {
  const entries = [];
  let sceneStart = 0;
  scenes.forEach((scene) => {
    const { durations, texts } = buildBeatTimeline(scene);
    let beatStart = sceneStart;
    durations.forEach((beatDuration, b) => {
      const words = String(texts[b] || '').split(/\s+/).filter(Boolean);
      computeWordTimings(words, beatDuration).forEach((t, i) => {
        entries.push({ word: words[i], start: beatStart + t.start, end: beatStart + t.end });
      });
      beatStart += beatDuration;
    });
    sceneStart += (scene.audioDuration || 0) + (scene.pad || 0);
  });
  return entries;
}

// One .srt cue per scene, spanning that scene's own real (measured) duration — matching exactly
// what's drawn on screen (engine.js's drawFlatText: the scene's whole narration, flat, for the
// scene's whole duration, no internal splitting). Safe because api/generate-scenes.js guarantees
// exactly one sentence per static_background scene, strictly, never two — there is nothing to
// split within a scene, the scene boundary already is the sentence boundary.
function buildStaticBackgroundBlocks(scenes) {
  const blocks = [];
  let sceneStart = 0;
  scenes.forEach((scene) => {
    const duration = (scene.audioDuration || 0) + (scene.pad || 0);
    const words = String(scene.narration || '').split(/\s+/).filter(Boolean);
    if (words.length) blocks.push({ words, start: sceneStart, end: sceneStart + duration });
    sceneStart += duration;
  });
  return blocks;
}

export function buildSrtFromScenes(scenes, isStaticBackground = false) {
  const blocks = isStaticBackground
    ? buildStaticBackgroundBlocks(scenes || [])
    : groupWordsIntoBlocks(collectWordEntries(scenes || []).filter((e) => e.word));
  return blocks
    .map((b, i) => `${i + 1}\n${formatSrtTimestamp(b.start)} --> ${formatSrtTimestamp(b.end)}\n${b.words.join(' ')}\n`)
    .join('\n');
}
