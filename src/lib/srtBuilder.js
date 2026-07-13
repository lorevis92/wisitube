// Builds a standard .srt caption file from a project's scenes, reusing the exact per-word timing
// engine.js computes for the kinetic subtitle overlay burned into the exported video — so the
// uploaded captions track always lines up with what viewers see on screen, not an independent guess.
import { computeWordTimings, splitNarrationHalves } from './engine';

const MAX_BLOCK_SECONDS = 4;

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Absolute (timeline-wide) start/end for every narrated word — each scene's duration is split
// into two beat halves exactly like drawFrame() does, so the timestamps match frame-for-frame.
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

// Groups consecutive words into subtitle blocks capped at MAX_BLOCK_SECONDS — a new block starts
// as soon as adding the next word would push the running block past that cap.
function groupIntoBlocks(entries) {
  const blocks = [];
  let current = null;
  entries.forEach((entry) => {
    if (current && entry.end - current.start <= MAX_BLOCK_SECONDS) {
      current.words.push(entry.word);
      current.end = entry.end;
      return;
    }
    if (current) blocks.push(current);
    current = { words: [entry.word], start: entry.start, end: entry.end };
  });
  if (current) blocks.push(current);
  return blocks;
}

export function buildSrtFromScenes(scenes) {
  const entries = collectWordEntries(scenes || []).filter((e) => e.word);
  const blocks = groupIntoBlocks(entries);
  return blocks
    .map((b, i) => `${i + 1}\n${formatSrtTimestamp(b.start)} --> ${formatSrtTimestamp(b.end)}\n${b.words.join(' ')}\n`)
    .join('\n');
}
