// Kokoro TTS — free, unlimited, in-browser text-to-speech (ONNX model runs locally).
// The model (~90MB) is downloaded once and cached by the browser.

export const KOKORO_VOICES = {
  'English US': [
    { id: 'af_heart', label: 'af_heart' },
    { id: 'af_bella', label: 'af_bella' },
    { id: 'am_michael', label: 'am_michael' },
    { id: 'am_fenrir', label: 'am_fenrir' },
  ],
  'English UK': [
    { id: 'bf_emma', label: 'bf_emma' },
    { id: 'bm_george', label: 'bm_george' },
  ],
  Italiano: [
    { id: 'if_sara', label: 'if_sara' },
    { id: 'im_nicola', label: 'im_nicola' },
  ],
  Español: [{ id: 'ef_dora', label: 'ef_dora' }],
  Français: [{ id: 'ff_siwis', label: 'ff_siwis' }],
};

let progressListeners = new Set();

export function onLoadProgress(callback) {
  progressListeners.add(callback);
  return () => progressListeners.delete(callback);
}

function emitProgress(info) {
  for (const cb of progressListeners) cb(info);
}

let ttsPromise = null;

function loadTTS() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js');
      // Always use the WASM backend, even when navigator.gpu is available. onnxruntime's WebGPU
      // backend has been observed to crash the GPU driver on Windows (DXGI_ERROR_DEVICE_HUNG) —
      // this is a stability tradeoff, not a performance choice.
      return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (info) => emitProgress(info),
      });
    })();
  }
  return ttsPromise;
}

// Serialize generations — WASM runs single-threaded, so overlapping calls would just queue anyway.
let queue = Promise.resolve();

export function generateSpeech(text, voice) {
  const run = async () => {
    const tts = await loadTTS();
    const audio = await tts.generate(text, { voice });
    return audio.toBlob();
  };
  const result = queue.then(run);
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}
