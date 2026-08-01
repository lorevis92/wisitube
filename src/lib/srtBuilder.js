// Builds a standard .srt caption file from a project's scenes, reusing the exact per-word timing
// engine.js computes for the on-screen subtitle/caption rendering — so the uploaded captions track
// always lines up with what viewers see on screen, not an independent guess. Block chunking itself
// (groupWordsIntoBlocks) is shared with engine.js's drawFlatText (static_background's on-screen
// caption) rather than reimplemented here, so the two can never drift apart over time.
import { computeWordTimings, splitNarrationHalves, groupWordsIntoBlocks } from './engine';

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Absolute (timeline-wide) start/end for every narrated word.
//
// isStaticBackground: static_background scenes have no image beats at all (see App.jsx's
// buildScenesFromRaw/engine.js's drawFlatText) — the whole scene's narration is timed as ONE
// continuous span across its full duration, matching exactly what's drawn on screen
// (computeCaptionBlocks). Every other content type still splits each scene into the two beat
// halves drawSubtitle's kinetic overlay uses, so the two stay in lockstep there too.
function collectWordEntries(scenes, isStaticBackground) {
  const entries = [];
  let sceneStart = 0;
  scenes.forEach((scene) => {
    const duration = (scene.audioDuration || 0) + (scene.pad || 0);

    if (isStaticBackground) {
      const words = String(scene.narration || '').split(/\s+/).filter(Boolean);
      computeWordTimings(words, duration).forEach((t, i) => {
        entries.push({ word: words[i], start: sceneStart + t.start, end: sceneStart + t.end });
      });
    } else {
      const half = Math.max(0.0001, duration / 2);
      const [firstHalf, secondHalf] = splitNarrationHalves(scene.narration);

      computeWordTimings(firstHalf, half).forEach((t, i) => {
        entries.push({ word: firstHalf[i], start: sceneStart + t.start, end: sceneStart + t.end });
      });
      computeWordTimings(secondHalf, half).forEach((t, i) => {
        entries.push({ word: secondHalf[i], start: sceneStart + half + t.start, end: sceneStart + half + t.end });
      });
    }

    sceneStart += duration;
  });
  return entries;
}

export function buildSrtFromScenes(scenes, isStaticBackground = false) {
  const entries = collectWordEntries(scenes || [], isStaticBackground).filter((e) => e.word);
  const blocks = groupWordsIntoBlocks(entries);
  return blocks
    .map((b, i) => `${i + 1}\n${formatSrtTimestamp(b.start)} --> ${formatSrtTimestamp(b.end)}\n${b.words.join(' ')}\n`)
    .join('\n');
}
