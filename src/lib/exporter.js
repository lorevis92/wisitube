// Offline video export via WebCodecs + mp4-muxer — renders every frame directly (no real-time
// canvas capture), so a render finishes in a fraction of the video's own duration instead of
// taking exactly as long as the video plays. Falls back to the real-time MediaRecorder/WebM path
// in src/lib/engine.js when WebCodecs isn't available (see WebCodecsUnsupportedError below).

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { drawFrame, totalDuration } from './engine';

const FPS = 30;
const KEYFRAME_INTERVAL_FRAMES = FPS * 2; // force a keyframe every 2 seconds
const VIDEO_CODEC = 'avc1.4d401f'; // H.264 Main Profile, Level 3.1 — covers 1280x720 and 720x1280 alike
const VIDEO_BITRATE = 6_000_000;
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const AAC_CONFIG = { codec: 'mp4a.40.2', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE };
const OPUS_CONFIG = { codec: 'opus', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE };

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

// AudioData with format 'f32-planar' expects one Float32Array plane per channel, back-to-back —
// exactly what AudioBuffer.getChannelData() already gives per channel, just concatenated.
function planarChunk(buffer, frameStart, frameCount) {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(channels * frameCount);
  for (let ch = 0; ch < channels; ch++) {
    out.set(buffer.getChannelData(ch).subarray(frameStart, frameStart + frameCount), ch * frameCount);
  }
  return out;
}

async function encodeAudio(muxer, renderedBuffer) {
  let config = AAC_CONFIG;
  const aacSupport = await AudioEncoder.isConfigSupported(AAC_CONFIG);
  if (!aacSupport.supported) config = OPUS_CONFIG;

  let encodeError = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const CHUNK_FRAMES = AUDIO_SAMPLE_RATE; // ~1s per AudioData fed in; the encoder handles its own internal framing
  let frameStart = 0;
  while (frameStart < renderedBuffer.length) {
    const frameCount = Math.min(CHUNK_FRAMES, renderedBuffer.length - frameStart);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: renderedBuffer.sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: renderedBuffer.numberOfChannels,
      timestamp: Math.round((frameStart / renderedBuffer.sampleRate) * 1e6),
      data: planarChunk(renderedBuffer, frameStart, frameCount),
    });
    encoder.encode(data);
    data.close();
    frameStart += frameCount;
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
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

  const videoConfig = { codec: VIDEO_CODEC, width, height, bitrate: VIDEO_BITRATE, framerate: FPS };
  const videoSupport = await VideoEncoder.isConfigSupported(videoConfig);
  if (!videoSupport.supported) throw new WebCodecsUnsupportedError('This browser cannot encode H.264 via WebCodecs');

  const total = totalDuration(items);
  const totalFrames = Math.max(1, Math.ceil(total * FPS));

  const aacSupport = await AudioEncoder.isConfigSupported(AAC_CONFIG);
  const audioCodec = aacSupport.supported ? 'aac' : 'opus';

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: FPS },
    audio: { codec: audioCodec, numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE },
    fastStart: 'in-memory',
  });

  // Audio is rendered non-realtime up front — it's comparatively fast and doesn't need
  // frame-by-frame progress reporting like the video encode loop below does.
  const renderedAudio = await renderMixedAudio(items, total);
  await encodeAudio(muxer, renderedAudio);
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  let videoEncodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoEncodeError = e; },
  });
  videoEncoder.configure(videoConfig);

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    if (signal?.aborted) {
      videoEncoder.close();
      throw new DOMException('Export cancelled', 'AbortError');
    }
    if (videoEncodeError) throw videoEncodeError;

    const t = frameIndex / FPS;
    drawFrame(ctx, items, t, { W: width, H: height, subtitles });

    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
    videoEncoder.encode(frame, { keyFrame: frameIndex % KEYFRAME_INTERVAL_FRAMES === 0 });
    frame.close();

    if (frameIndex % 30 === 0) {
      await Promise.resolve(); // yield a microtask so this loop doesn't fully monopolize the thread
      if (onProgress) onProgress(frameIndex, totalFrames);
    }
  }

  await videoEncoder.flush();
  videoEncoder.close();
  if (videoEncodeError) throw videoEncodeError;
  if (onProgress) onProgress(totalFrames, totalFrames);

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
