// Runs Kokoro off the main thread — model load + inference are CPU-heavy (WASM) and were
// freezing the page when run inline. This worker owns the model instance exclusively.

let ttsPromise = null;

function loadTTS() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js');
      // Always WASM/q8 — see tts.js for why WebGPU is avoided (driver stability on Windows).
      return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (info) => postMessage({ type: 'progress', ...info }),
      });
    })();
  }
  return ttsPromise;
}

// Chain every request onto the same promise — the model must not be invoked concurrently.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const { type } = e.data;

  if (type === 'load') {
    queue = queue.then(async () => {
      try {
        await loadTTS();
        postMessage({ type: 'ready' });
      } catch (err) {
        postMessage({ type: 'error', message: err?.message || String(err) });
      }
    });
    return;
  }

  if (type === 'generate') {
    const { id, text, voice } = e.data;
    queue = queue.then(async () => {
      try {
        const tts = await loadTTS();
        const audio = await tts.generate(text, { voice });
        const blob = await audio.toBlob();
        postMessage({ type: 'result', id, blob });
      } catch (err) {
        postMessage({ type: 'error', id, message: err?.message || String(err) });
      }
    });
  }
};
