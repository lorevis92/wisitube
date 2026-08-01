// Builds a standard .srt caption file from a project's scenes, reusing the exact per-word timing
// engine.js computes for the on-screen subtitle rendering — so the uploaded captions track always
// lines up with what viewers see on screen, not an independent guess.
import { computeWordTimings, splitNarrationHalves, groupWordsIntoBlocks, splitSentencesWithTiming } from './engine';

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Absolute (timeline-wide) start/end for every narrated word — each scene's duration is split into
// two beat halves exactly like drawSubtitle()/drawScene() do, so the timestamps match frame-for-
// frame. full_pipeline only (see buildSrtFromScenes) — static_background has no beats to split.
function collectWordEntries(scenes) {
  const entries = [];
  let sceneStart = 0;
  scenes.forEach((scene) => {
    const duration = (scene.audioDuration || 0) + (scene.pad || 0);
    const half = Math.max(0.0001, duration / 2);
    const [firstHalf, secondHalf] = splitNarrationHalves(scene.narration);

    computeWordTimings(firstHalf, half).forEach((t, i) => {
      entries.push({ word: firstHalf[i], start: sceneStart + t.start, end: sceneStart + t.end });
    });
    computeWordTimings(secondHalf, half).forEach((t, i) => {
      entries.push({ word: secondHalf[i], start: sceneStart + half + t.start, end: sceneStart + half + t.end });
    });

    sceneStart += duration;
  });
  return entries;
}

// One .srt cue per SENTENCE (see splitSentencesWithTiming, shared with engine.js's drawFlatText),
// each spanning its own proportional share of the scene's real (measured) duration — matching
// exactly what's drawn on screen: a single-sentence scene (the common case) is one cue for the
// whole duration, an occasional two-sentence scene becomes two cues that cut exactly at the
// sentence boundary.
function buildStaticBackgroundBlocks(scenes) {
  const blocks = [];
  let sceneStart = 0;
  scenes.forEach((scene) => {
    const duration = (scene.audioDuration || 0) + (scene.pad || 0);
    splitSentencesWithTiming(scene.narration, duration).forEach((b) => {
      if (b.words.length) blocks.push({ words: b.words, start: sceneStart + b.start, end: sceneStart + b.end });
    });
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
