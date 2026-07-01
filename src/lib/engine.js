// WisiTube timeline engine.
// One code path drives both the live preview and the WebM export:
// audio is scheduled on an AudioContext, the canvas is drawn every frame from
// the audio clock, so image/animation changes are sample-accurate with the voiceover.

export const ANIMATION_LIST = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'drift_up', 'static'];

const ANIMATIONS = {
  zoom_in: (p) => ({ scale: 1.03 + 0.16 * p, dx: 0, dy: 0 }),
  zoom_out: (p) => ({ scale: 1.19 - 0.16 * p, dx: 0, dy: 0 }),
  pan_left: (p) => ({ scale: 1.16, dx: 0.05 - 0.1 * p, dy: 0 }),
  pan_right: (p) => ({ scale: 1.16, dx: -0.05 + 0.1 * p, dy: 0 }),
  drift_up: (p) => ({ scale: 1.16, dx: 0, dy: 0.04 - 0.08 * p }),
  static: () => ({ scale: 1.04, dx: 0, dy: 0 }),
};

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

function wrapLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawSubtitle(ctx, W, H, text) {
  const fontSize = Math.round(H * 0.038);
  ctx.font = `700 ${fontSize}px Syne, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const lines = wrapLines(ctx, text, W * 0.86).slice(0, 3);
  const lineH = fontSize * 1.28;
  const baseY = H - H * 0.055;
  lines.forEach((ln, i) => {
    const y = baseY - (lines.length - 1 - i) * lineH;
    ctx.lineWidth = Math.max(3, fontSize * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(ln, W / 2, y);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(ln, W / 2, y);
  });
}

export function pickMime() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

/**
 * items: [{ img: HTMLImageElement, buffer: AudioBuffer, duration: number, narration, animation }]
 * duration already includes any per-scene padding (>= buffer.duration).
 * Returns a controller: { stop(), total, blobPromise (only when record=true) }
 */
export async function playTimeline({ canvas, items, subtitles = false, record = false, onProgress, onDone }) {
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

  const FADE = 0.35;

  function drawScene(item, p, alpha = 1) {
    const tr = (ANIMATIONS[item.animation] || ANIMATIONS.zoom_in)(ease(p));
    ctx.globalAlpha = alpha;
    drawCover(ctx, item.img, W, H, tr.scale, tr.dx, tr.dy);
    ctx.globalAlpha = 1;
  }

  function frame() {
    if (stopped) return;
    const now = ac.currentTime - startAt;
    const tt = Math.max(0, Math.min(now, total));

    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (tt >= starts[i]) idx = i;
    }
    const it = items[idx];
    const local = tt - starts[idx];
    const p = Math.min(1, Math.max(0, local / it.duration));

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    drawScene(it, p, 1);
    if (idx > 0 && local < FADE) {
      drawScene(items[idx - 1], 1, 1 - local / FADE);
    }
    if (subtitles) drawSubtitle(ctx, W, H, it.narration);

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
