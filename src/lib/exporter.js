// Offline video export via Mediabunny (WebCodecs-based) — renders every frame directly (no
// real-time canvas capture), so a render finishes in a fraction of the video's own duration
// instead of taking exactly as long as the video plays. Falls back to the real-time
// MediaRecorder/WebM path in src/lib/engine.js when WebCodecs isn't available (see
// WebCodecsUnsupportedError below).
//
// Mediabunny's CanvasSource/AudioBufferSource manage VideoEncoder/AudioEncoder internally
// (keyframe interval, backpressure, canvas-frame capture, audio sample conversion), so this file
// only has to draw frames and hand off whole buffers — no manual encoder/muxer wiring needed.

import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeVideo, canEncodeAudio } from 'mediabunny';
import { drawFrame, totalDuration } from './engine';

const FPS = 30;
const KEYFRAME_INTERVAL_S = 2; // matches CanvasSource's own default, set explicitly for clarity
const VIDEO_BITRATE = 6_000_000;
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;

export class WebCodecsUnsupportedError extends Error {
  constructor(msg) {
    super(msg || 'WebCodecs is not supported in this browser');
    this.name = 'WebCodecsUnsupportedError';
  }
}

// Renders the full mixed audio track (all items scheduled at their timeline start, same math as
// playTimeline's real-time scheduling) non-realtime via OfflineAudioContext.
async function renderMixedAudio(items, total) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const length = Math.max(1, Math.ceil(total * AUDIO_SAMPLE_RATE));
  const ctx = new OfflineCtx(AUDIO_CHANNELS, length, AUDIO_SAMPLE_RATE);

  let acc = 0;
  items.forEach((it) => {
    const src = ctx.createBufferSource();
    src.buffer = it.buffer;
    src.connect(ctx.destination);
    src.start(acc);
    acc += it.duration;
  });

  return ctx.startRendering();
}

/**
 * items: same shape as playTimeline's — [{ images: [{img, animation}, {img, animation}], buffer, duration, narration }]
 * Returns a Promise<Blob> (video/mp4). Throws WebCodecsUnsupportedError if the browser lacks
 * VideoEncoder/AudioEncoder — callers should catch that specifically and fall back to the
 * MediaRecorder/WebM path.
 */
export async function renderToMp4({ items, width, height, subtitles = false, onProgress, signal }) {
  if (typeof window === 'undefined' || typeof window.VideoEncoder === 'undefined' || typeof window.AudioEncoder === 'undefined') {
    throw new WebCodecsUnsupportedError();
  }

  const videoOk = await canEncodeVideo('avc', { width, height, bitrate: VIDEO_BITRATE });
  if (!videoOk) throw new WebCodecsUnsupportedError('This browser cannot encode H.264 via WebCodecs');

  const aacOk = await canEncodeAudio('aac', { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE });
  const audioCodec = aacOk ? 'aac' : 'opus';

  const total = totalDuration(items);
  const totalFrames = Math.max(1, Math.ceil(total * FPS));

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: VIDEO_BITRATE,
    keyFrameInterval: KEYFRAME_INTERVAL_S,
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });

  const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: AUDIO_BITRATE });
  output.addAudioTrack(audioSource);

  await output.start();

  const abortIfNeeded = async () => {
    if (!signal?.aborted) return;
    await output.cancel();
    throw new DOMException('Export cancelled', 'AbortError');
  };

  // Audio is rendered non-realtime up front — it's comparatively fast and doesn't need
  // frame-by-frame progress reporting like the video encode loop below does.
  const renderedAudio = await renderMixedAudio(items, total);
  await audioSource.add(renderedAudio);
  audioSource.close();
  await abortIfNeeded();

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    await abortIfNeeded();

    const t = frameIndex / FPS;
    drawFrame(ctx, items, t, { W: width, H: height, subtitles });
    await videoSource.add(t, 1 / FPS); // awaiting respects the encoder's own backpressure

    if (frameIndex % 30 === 0 && onProgress) onProgress(frameIndex, totalFrames);
  }
  videoSource.close();
  if (onProgress) onProgress(totalFrames, totalFrames);

  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
