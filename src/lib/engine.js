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
// srtBuilder.js for full_pipeline's two-beat-halved narration only — static_background doesn't
// need an estimated time cap at all, its .srt cues already come one per scene, at the scene's own
// real duration (see srtBuilder.js's isStaticBackground branch).
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

function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// Pops in at 1.3x and settles to the 1.15x resting emphasis size within ~150ms, with a slight
// elastic dip below 1.15x on the way there for a bit of energy.
function wordPopScale(elapsedMs) {
  const t = Math.min(1, Math.max(0, elapsedMs / 150));
  return 1.15 + 0.15 * (1 - easeOutBack(t));
}

// Splits a narration into the word groups shown during each of the scene's two image beats — the
// first Math.ceil(n/2) words during beat 1, the rest during beat 2. For 1-2 total words this
// already degenerates naturally into "everything in beat 1, nothing in beat 2" rather than an
// unnatural split, so no extra special-casing is needed.
export function splitNarrationHalves(narration) {
  const words = String(narration || '').split(/\s+/).filter(Boolean);
  const cut = Math.ceil(words.length / 2);
  return [words.slice(0, cut), words.slice(cut)];
}

function drawSubtitle(ctx, W, H, words, localTime, duration) {
  if (!words.length) return;

  const fontSize = Math.round(H * 0.038);
  ctx.font = `700 ${fontSize}px Syne, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = Math.max(3, fontSize * 0.16);

  const timings = computeWordTimings(words, duration);
  const clampedTime = Math.min(Math.max(localTime, 0), duration);
  let activeIdx = timings.findIndex((t) => clampedTime >= t.start && clampedTime < t.end);
  if (activeIdx === -1 && clampedTime >= duration) activeIdx = words.length - 1;

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

      if (wordIdx === activeIdx) {
        const elapsedMs = Math.max(0, (clampedTime - timings[wordIdx].start) * 1000);
        const scale = wordPopScale(elapsedMs);
        const cx = x + wWidth / 2;
        ctx.save();
        ctx.translate(cx, y);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -y);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(word, x, y);
        ctx.fillStyle = '#E8352A';
        ctx.fillText(word, x, y);
        ctx.restore();
      } else {
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(word, x, y);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(word, x, y);
      }
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
  const tr = (ANIMATIONS[beat.animation] || ANIMATIONS.zoom_in)(ease(p));
  ctx.globalAlpha = alpha;
  drawCover(ctx, beat.img, W, H, tr.scale, tr.dx, tr.dy);
  ctx.globalAlpha = 1;
}

// Single source of truth for "which half of the scene are we in" — shared by the image beats and
// the subtitles so the two switch at exactly the same instant.
function sceneBeatState(item, local) {
  const half = Math.max(0.0001, item.duration / 2);
  const inSecondBeat = local >= half;
  const beatLocal = inSecondBeat ? local - half : local;
  return { half, inSecondBeat, beatLocal };
}

// local: seconds elapsed since this scene started (clamped to [0, item.duration] by the caller).
function drawScene(ctx, W, H, item, local, alpha = 1) {
  const { half, inSecondBeat, beatLocal } = sceneBeatState(item, local);
  const beatP = Math.min(1, Math.max(0, beatLocal / half));

  drawBeat(ctx, W, H, item.images[inSecondBeat ? 1 : 0], beatP, alpha);
  if (inSecondBeat && beatLocal < BEAT_FADE) {
    // Cross-fade the outgoing beat 1's final frame out on top of the incoming beat 2.
    drawBeat(ctx, W, H, item.images[0], 1, alpha * (1 - beatLocal / BEAT_FADE));
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
    const { half, inSecondBeat, beatLocal } = sceneBeatState(it, local);
    const [firstHalfWords, secondHalfWords] = splitNarrationHalves(it.narration);
    drawSubtitle(ctx, W, H, inSecondBeat ? secondHalfWords : firstHalfWords, beatLocal, half);
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
 * items: [{ images: [{img: HTMLImageElement, animation}, {img, animation}], buffer: AudioBuffer, duration: number, narration }]
 * Each item's duration is split evenly between its two image beats, with a short crossfade at
 * the midpoint. duration already includes any per-scene padding (>= buffer.duration).
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
