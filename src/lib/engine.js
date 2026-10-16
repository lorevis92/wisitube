// WisiTube timeline engine.
// drawFrame() is the single source of truth for "what does the video look like at time t" —
// used both by the live preview/real-time recorder below and by the offline WebCodecs exporter
// (src/lib/exporter.js), so the exported video always matches what was previewed.

export const ANIMATION_LIST = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'drift_up', 'static'];

const ANIMATIONS = {
  zoom_in: (p) => ({ scale: 1.03 + 0.16 * p, dx: 0, dy: 0 }),
  zoom_out: (p) => ({ scale: 1.19 - 0.16 * p, dx: 0, dy: 0 }),
  pan_left: (p) => ({ scale: 1.16, dx: 0.05 - 0.1 * p, dy: 0 }),
  pan_right: (p) => ({ scale: 1.16, dx: -0.05 + 0.1 * p, dy: 0 }),
  drift_up: (p) => ({ scale: 1.16, dx: 0, dy: 0.04 - 0.08 * p }),
  static: () => ({ scale: 1.04, dx: 0, dy: 0 }),
};

const FADE = 0.35; // crossfade between scenes
const BEAT_FADE = 0.3; // shorter crossfade between a scene's two image beats

function ease(p) {
  return p * p * (3 - 2 * p); // smoothstep
}

function drawCover(ctx, img, W, H, scale, dx, dy) {
  const ir = img.width / img.height;
  const cr = W / H;
  let dw, dh;
  if (ir > cr) {
    dh = H;
    dw = H * ir;
  } else {
    dw = W;
    dh = W / ir;
  }
  dw *= scale;
  dh *= scale;
  const x = (W - dw) / 2 + dx * W;
  const y = (H - dh) / 2 + dy * H;
  ctx.drawImage(img, x, y, dw, dh);
}

// Wraps by word while keeping each word's original index, so the active word can be picked out
// and re-positioned individually without reflowing the rest of the line.
function wrapWordIndices(ctx, words, maxWidth) {
  const lines = [];
  let current = [];
  let currentText = '';
  words.forEach((w, i) => {
    const test = currentText ? currentText + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && currentText) {
      lines.push(current);
      current = [i];
      currentText = w;
    } else {
      current.push(i);
      currentText = test;
    }
  });
  if (current.length) lines.push(current);
  return lines;
}

// Splits the scene's duration across its words proportionally to word length — a reasonable
// stand-in for real word-level audio timing without needing forced alignment. Exported so
// srtBuilder.js can derive .srt cue timestamps from the exact same per-word timing the kinetic
// subtitle overlay uses, keeping the two in lockstep.
export function computeWordTimings(words, duration) {
  const weights = words.map((w) => Math.max(1, w.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return words.map((w, i) => {
    const start = (acc / totalWeight) * duration;
    acc += weights[i];
    const end = (acc / totalWeight) * duration;
    return { start, end };
  });
}

// Default cap on how long (in seconds) a single .srt caption block may span before a new one
// starts — matches how long a real subtitle line comfortably stays on screen. Used by
// srtBuilder.js for full_pipeline's per-beat narration only — static_background doesn't need an
// estimated time cap at all, its .srt cues already come one per scene, at the scene's own real
// duration (see srtBuilder.js's isStaticBackground branch).
export const CAPTION_BLOCK_SECONDS = 4;

// Groups a sequence of already-timed entries ({ word, start, end } — e.g. from computeWordTimings)
// into short blocks capped at maxSeconds: a new block starts as soon as adding the next entry would
// push the running one past that cap.
export function groupWordsIntoBlocks(entries, maxSeconds = CAPTION_BLOCK_SECONDS) {
  const blocks = [];
  let current = null;
  entries.forEach((entry) => {
    if (current && entry.end - current.start <= maxSeconds) {
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

// Splits a narration into one word group per beat, used for any scene whose beats carry no explicit
// narration span: every video created before spans existed, and any scene whose spans stopped
// matching its narration (see spansCoverNarration). Greedy ceil distribution — each part takes
// ceil(remainingWords / remainingParts) — which for a 2-beat scene reproduces exactly the old
// "first Math.ceil(n/2) words, then the rest" behavior, so an existing video's subtitles stay
// identical word for word. For 1-2 total words it degenerates naturally into "everything in the
// first beat, nothing in the rest" rather than an unnatural split.
export function splitNarrationParts(narration, partCount) {
  const words = String(narration || '').split(/\s+/).filter(Boolean);
  const parts = [];
  const n = Math.max(1, partCount);
  let taken = 0;
  for (let p = 0; p < n; p++) {
    const take = Math.ceil((words.length - taken) / (n - p));
    parts.push(words.slice(taken, taken + take));
    taken += take;
  }
  return parts;
}

// Floor/ceiling on how long a single image may hold the frame. The floor is not arbitrary: BEAT_FADE
// (0.3s) of every beat is spent cross-fading, which at 2s is a tolerable 15% of the beat and below
// ~1.5s starts to read as a dissolve rather than a cut. The ceiling is where a Ken Burns move over a
// still image stops feeling like motion.
export const MIN_BEAT_SECONDS = 2;
export const MAX_BEAT_SECONDS = 8;

const normalizeNarration = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// True when every beat of this scene carries a narration span AND those spans, in order, reconstruct
// the scene's own narration. api/generate-scenes.js already validates this server-side and drops the
// spans when they don't line up, so this is the client's own backstop — it also catches a scene
// whose narration was rewritten AFTER its spans were written (repetitionAudit.js clears them for
// exactly that reason; this covers anything already saved in that state). Whitespace runs are
// collapsed on both sides first: a split that moved a single space across a boundary is still a
// faithful one, and throwing it away would needlessly fall back to even timing.
export function spansCoverNarration(scene) {
  const beats = scene?.images || [];
  if (beats.length < 2) return false;
  if (!beats.every((b) => typeof b?.narrationSpan === 'string' && b.narrationSpan.trim())) return false;
  return normalizeNarration(beats.map((b) => b.narrationSpan).join(' ')) === normalizeNarration(scene?.narration);
}

// Keeps every beat inside [MIN_BEAT_SECONDS, MAX_BEAT_SECONDS] while holding the sum exactly at
// `total` — the sum IS this scene's audio length, so shedding even a few tenths here would desync
// every scene after it. When the range simply cannot contain `total` (a short scene can't give both
// beats 2s; a long one can't keep both under 8s without more beats than exist), there is nothing to
// honour and an even split is the best available answer.
function clampBeatDurations(raw, total) {
  const n = raw.length;
  if (!n) return [];
  if (total < n * MIN_BEAT_SECONDS || total > n * MAX_BEAT_SECONDS) return raw.map(() => total / n);

  const out = raw.map((d) => Math.min(MAX_BEAT_SECONDS, Math.max(MIN_BEAT_SECONDS, d)));
  // Push whatever the clamp added or removed back onto the beats that still have room for it.
  // Bounded by n passes: each pass either settles the total or saturates at least one more beat.
  for (let pass = 0; pass < n; pass++) {
    const diff = total - out.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) < 1e-9) break;
    const movable = out.map((_, i) => i).filter((i) => (diff > 0 ? out[i] < MAX_BEAT_SECONDS : out[i] > MIN_BEAT_SECONDS));
    if (!movable.length) break;
    const share = diff / movable.length;
    movable.forEach((i) => {
      out[i] = Math.min(MAX_BEAT_SECONDS, Math.max(MIN_BEAT_SECONDS, out[i] + share));
    });
  }
  // Float residue only (the loop converges to ~1e-15) — parked on the longest beat so the sum is
  // exact rather than merely close.
  const residue = total - out.reduce((a, b) => a + b, 0);
  if (residue !== 0) {
    let longest = 0;
    out.forEach((d, i) => {
      if (d > out[longest]) longest = i;
    });
    out[longest] += residue;
  }
  return out;
}

/**
 * Per-beat timing and caption text for one scene — the single source of truth for "when does the
 * image change, and which words are on screen while it's up". Shared by drawFrame below, by the
 * three places that build render items (videoRenderEngine.js, EditorStep.jsx, ExportStep.jsx) and by
 * srtBuilder.js, so the exported MP4, the live preview and the .srt track can never disagree.
 *
 * With spans: each beat lasts as long as its own words take to speak, estimated with
 * computeWordTimings — the same character-proportional model the .srt timestamps already use, so an
 * image cut and its caption always land on the same instant — then clamped (see above). Without
 * them: an even split, which for the 2-beat scenes every pre-span video is made of is exactly the
 * `duration / 2` this module used to hardcode, frame for frame.
 *
 * Returns { durations: number[], texts: string[] }, both one entry per beat, durations summing to
 * the scene's full (audio + pad) length.
 */
export function buildBeatTimeline(scene) {
  const beats = scene?.images || [];
  const duration = (scene?.audioDuration || 0) + (scene?.pad || 0);
  if (!beats.length) return { durations: [], texts: [] };

  if (!spansCoverNarration(scene)) {
    return {
      durations: beats.map(() => duration / beats.length),
      texts: splitNarrationParts(scene?.narration, beats.length).map((words) => words.join(' ')),
    };
  }

  const texts = beats.map((b) => b.narrationSpan.trim());
  // Word timings are computed across the WHOLE scene and each span's boundary is then read off them,
  // rather than timing each span on its own — timing them separately would hand every span an equal
  // share of the scene and discard the very fact (one span takes longer to speak than the other)
  // this function exists to use.
  const perSpanWords = texts.map((t) => t.split(/\s+/).filter(Boolean));
  const timings = computeWordTimings(perSpanWords.flat(), duration);
  const raw = [];
  let cursor = 0;
  perSpanWords.forEach((words) => {
    const startAt = cursor === 0 ? 0 : timings[cursor - 1].end;
    cursor += words.length;
    raw.push(Math.max(0, timings[cursor - 1].end - startAt));
  });
  return { durations: clampBeatDurations(raw, duration), texts };
}

function drawSubtitle(ctx, W, H, words) {
  if (!words.length) return;

  const fontSize = Math.round(H * 0.038);
  ctx.font = `700 ${fontSize}px Syne, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = Math.max(3, fontSize * 0.16);

  const maxWidth = W * 0.86;
  const lineGroups = wrapWordIndices(ctx, words, maxWidth).slice(0, 3);
  const spaceWidth = ctx.measureText(' ').width;
  const lineH = fontSize * 1.28;
  const baseY = H - H * 0.055;

  lineGroups.forEach((indices, li) => {
    const y = baseY - (lineGroups.length - 1 - li) * lineH;
    const widths = indices.map((i) => ctx.measureText(words[i]).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + spaceWidth * (indices.length - 1);
    let x = W / 2 - totalWidth / 2;

    ctx.textAlign = 'left';
    indices.forEach((wordIdx, k) => {
      const word = words[wordIdx];
      const wWidth = widths[k];

      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(word, x, y);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(word, x, y);
      x += wWidth + spaceWidth;
    });
  });
}

// content_type 'static_background' — the entire video is one unchanging background (solid color
// or a single generated image, no Ken Burns/pan/zoom) with the current scene's whole narration
// drawn flat on top (no kinetic word-pop). See drawFlatText below for the text half; this only
// paints the background itself, once per frame (cheap — it's identical every frame, no per-item
// lookup needed).
function drawStaticBg(ctx, W, H, background) {
  if (background?.type === 'image' && background.img) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, background.img, W, H, 1, 0, 0);
  } else {
    ctx.fillStyle = background?.color || '#111111';
    ctx.fillRect(0, 0, W, H);
  }
}

// Auto-shrinks fontSize until every line of the (already word-wrapped) narration fits within
// maxHeight — a scene's whole narration is already short (api/generate-scenes.js writes exactly
// one sentence per static_background scene, strictly, never two), so this rarely needs to shrink
// much; MAX_FLAT_TEXT_LINES below is a generous safety backstop, not a design target.
function fitFlatText(ctx, words, maxWidth, maxHeight, maxFontSize, minFontSize) {
  let fontSize = maxFontSize;
  let lineGroups;
  let lineH;
  do {
    ctx.font = `600 ${fontSize}px Syne, sans-serif`;
    lineGroups = wrapWordIndices(ctx, words, maxWidth);
    lineH = fontSize * 1.35;
    if (lineGroups.length * lineH <= maxHeight) break;
    fontSize -= 2;
  } while (fontSize > minFontSize);
  return { fontSize, lineGroups, lineH };
}

// Generous safety backstop only — static_background has the whole screen to itself (no image, no
// competing visual element), so there's no reason to force brevity the way a real subtitle overlay
// would. This just guards against an unusually long sentence overflowing the frame; it is not meant
// to be hit in the normal case now that scenes are sentence-length (see api/generate-scenes.js).
const MAX_FLAT_TEXT_LINES = 6;

// Draws the scene's ENTIRE narration as one flat block of text (no word-level timing/animation)
// for the scene's whole real duration, no internal splitting at all — exactly the scene-boundary-
// exact sync model full_pipeline's own subtitle already uses, just without the per-word kinetic
// pop. Safe because api/generate-scenes.js guarantees exactly one sentence per static_background
// scene, strictly, never two — the scene boundary and the sentence boundary are the same thing, so
// there is nothing to split within a scene. Styled per textStyle (project.staticTextStyle, or the
// channel's automation_static_text_* defaults it was seeded from — see StoryboardStep.jsx).
function drawFlatText(ctx, W, H, narration, textStyle) {
  const words = String(narration || '').split(/\s+/).filter(Boolean);
  if (!words.length) return;

  const maxWidth = W * 0.82;
  const maxFontSize = Math.round(H * 0.075);
  const minFontSize = Math.round(H * 0.03);
  const maxHeight = maxFontSize * 1.35 * MAX_FLAT_TEXT_LINES;
  const { fontSize, lineGroups, lineH } = fitFlatText(ctx, words, maxWidth, maxHeight, maxFontSize, minFontSize);
  const lines = lineGroups.slice(0, MAX_FLAT_TEXT_LINES);

  ctx.font = `600 ${fontSize}px Syne, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const totalHeight = lines.length * lineH;
  const startY = H / 2 - totalHeight / 2 + lineH / 2;

  const textColor = textStyle?.textColor || '#FFFFFF';
  const outline = textStyle?.outline !== false;
  const outlineColor = textStyle?.outlineColor || '#000000';

  lines.forEach((indices, li) => {
    const line = indices.map((i) => words[i]).join(' ');
    const y = startY + li * lineH;
    if (outline) {
      ctx.lineWidth = Math.max(3, fontSize * 0.12);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = outlineColor;
      ctx.strokeText(line, W / 2, y);
    }
    ctx.fillStyle = textColor;
    ctx.fillText(line, W / 2, y);
  });
}

function drawBeat(ctx, W, H, beat, p, alpha) {
  // beat.img can be null for a beat whose image was lost to a failed Storage backup (see
  // mediaRehydration.js) — EditorStep.jsx/videoRenderEngine.js still build an item for it (so
  // timing/audio for the rest of the scene stays correct) but pass img: null instead of throwing.
  // Draw a plain black placeholder frame for it rather than crashing the whole draw call.
  if (!beat.img) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    return;
  }
  const tr = (ANIMATIONS[beat.animation] || ANIMATIONS.zoom_in)(ease(p));
  ctx.globalAlpha = alpha;
  drawCover(ctx, beat.img, W, H, tr.scale, tr.dx, tr.dy);
  ctx.globalAlpha = 1;
}

// Single source of truth for "which beat are we in" — shared by the image beats and the subtitles so
// the two switch at exactly the same instant. Boundaries come from item.beatDurations when the
// caller computed them (buildBeatTimeline above); an item without them falls back to an even split,
// which for a 2-beat scene is the `duration / 2` this used to hardcode — so every video created
// before per-beat durations existed renders exactly as it did.
function sceneBeatState(item, local) {
  const count = Math.max(1, (item.images || []).length);
  const durations =
    Array.isArray(item.beatDurations) && item.beatDurations.length === count
      ? item.beatDurations
      : new Array(count).fill(Math.max(0.0001, item.duration) / count);

  let index = 0;
  let start = 0;
  for (let i = 0; i < count; i++) {
    index = i;
    const end = start + durations[i];
    if (local < end || i === count - 1) break;
    start = end;
  }
  return { index, beatLocal: local - start, beatDuration: Math.max(0.0001, durations[index]) };
}

// The words on screen during one beat: that beat's own narration span when the item carries it
// (item.images[i].text, set by the item builders from buildBeatTimeline), otherwise this beat's share
// of an even word split — which is what the old two-halves behavior was.
function beatWords(item, index) {
  const beats = item.images || [];
  const text = beats[index]?.text;
  if (typeof text === 'string' && text.trim()) return text.split(/\s+/).filter(Boolean);
  return splitNarrationParts(item.narration, Math.max(1, beats.length))[index] || [];
}

// local: seconds elapsed since this scene started (clamped to [0, item.duration] by the caller).
function drawScene(ctx, W, H, item, local, alpha = 1) {
  const { index, beatLocal, beatDuration } = sceneBeatState(item, local);
  const beatP = Math.min(1, Math.max(0, beatLocal / beatDuration));

  drawBeat(ctx, W, H, item.images[index], beatP, alpha);
  if (index > 0 && beatLocal < BEAT_FADE) {
    // Cross-fade the outgoing beat's final frame out on top of the incoming one.
    drawBeat(ctx, W, H, item.images[index - 1], 1, alpha * (1 - beatLocal / BEAT_FADE));
  }
}

// Cumulative start time (seconds) of each item, in timeline order.
function computeStarts(items) {
  let acc = 0;
  return items.map((it) => {
    const s = acc;
    acc += it.duration;
    return s;
  });
}

export function totalDuration(items) {
  return items.reduce((a, it) => a + it.duration, 0);
}

/**
 * Draws the full frame (background, active scene + crossfade, subtitles) for absolute time `t`
 * (seconds) onto `ctx`. Pure with respect to the timeline: the same (items, t) always produces
 * the same pixels, whether called 60x/sec from the live preview or once per frame from the
 * offline exporter.
 *
 * staticBackground (content_type 'static_background' only): { type: 'color'|'image', color, img }
 * — when present, replaces the entire per-beat Ken Burns rendering with one unchanging background
 * for the whole video, plus the active scene's entire narration drawn flat on top for that scene's
 * whole real duration (see drawFlatText) — exactly one sentence per scene, always (see
 * api/generate-scenes.js), so the scene boundary IS the sentence boundary and there is no internal
 * splitting to do, same scene-boundary-exact sync model as full_pipeline's own subtitle.
 * `items` still only need `duration`/`narration`/`buffer` in this mode — `images` is never read.
 * textStyle: project.staticTextStyle — { textColor, outline, outlineColor }.
 */
export function drawFrame(ctx, items, t, { W, H, subtitles = false, staticBackground = null, textStyle = null } = {}) {
  const starts = computeStarts(items);
  const total = totalDuration(items);
  const tt = Math.max(0, Math.min(t, total));

  let idx = 0;
  for (let i = 0; i < items.length; i++) {
    if (tt >= starts[i]) idx = i;
  }
  const it = items[idx];
  const local = tt - starts[idx];

  if (staticBackground) {
    drawStaticBg(ctx, W, H, staticBackground);
    drawFlatText(ctx, W, H, it.narration, textStyle);
    return idx;
  }

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  drawScene(ctx, W, H, it, local, 1);
  if (idx > 0 && local < FADE) {
    const prev = items[idx - 1];
    drawScene(ctx, W, H, prev, prev.duration, 1 - local / FADE);
  }
  if (subtitles) {
    const { index } = sceneBeatState(it, local);
    drawSubtitle(ctx, W, H, beatWords(it, index));
  }

  return idx;
}

export function pickMime() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

/**
 * items: [{ images: [{img: HTMLImageElement, animation, text?}, ...], beatDurations?: number[],
 * buffer: AudioBuffer, duration: number, narration }]
 * Each item's duration is divided among its image beats by beatDurations (buildBeatTimeline), or
 * evenly when the caller didn't compute them, with a short crossfade at each boundary. duration
 * already includes any per-scene padding (>= buffer.duration).
 * Returns a controller: { stop(), total, blobPromise (only when record=true) }
 */
export async function playTimeline({ canvas, items, subtitles = false, staticBackground = null, textStyle = null, record = false, onProgress, onDone }) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  await ac.resume();

  const gain = ac.createGain();
  let dest = null;
  if (record) {
    dest = ac.createMediaStreamDestination();
    gain.connect(dest);
  } else {
    gain.connect(ac.destination);
  }

  const startAt = ac.currentTime + 0.35;
  let t = startAt;
  const starts = [];
  const sources = items.map((it) => {
    const s = ac.createBufferSource();
    s.buffer = it.buffer;
    s.connect(gain);
    s.start(t);
    starts.push(t - startAt);
    t += it.duration;
    return s;
  });
  const total = t - startAt;

  let recorder = null;
  const chunks = [];
  let stopped = false;
  let resolveBlob = null;
  const blobPromise = record
    ? new Promise((r) => {
        resolveBlob = r;
      })
    : null;

  if (record) {
    const vStream = canvas.captureStream(30);
    const mixed = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(mixed, { mimeType: pickMime(), videoBitsPerSecond: 6_000_000 });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => resolveBlob(new Blob(chunks, { type: 'video/webm' }));
    recorder.start(300);
  }

  function frame() {
    if (stopped) return;
    const now = ac.currentTime - startAt;
    const tt = Math.max(0, Math.min(now, total));

    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (tt >= starts[i]) idx = i;
    }

    drawFrame(ctx, items, tt, { W, H, subtitles, staticBackground, textStyle });

    if (onProgress) onProgress(tt, total, idx);

    if (now >= total + 0.35) {
      finish(true);
      return;
    }
    requestAnimationFrame(frame);
  }

  function finish(completed) {
    if (stopped) return;
    stopped = true;
    sources.forEach((s) => {
      try {
        s.stop();
      } catch { /* already stopped */ }
    });
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    setTimeout(() => {
      try {
        ac.close();
      } catch { /* ignore */ }
    }, 400);
    if (onDone) onDone(completed);
  }

  requestAnimationFrame(frame);
  return { stop: () => finish(false), total, blobPromise };
}
