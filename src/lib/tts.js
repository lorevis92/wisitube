// Kokoro TTS — free, unlimited, in-browser text-to-speech (ONNX model runs locally).
// The model (~90MB) is downloaded once and cached by the browser. Inference runs in a Web
// Worker (see tts.worker.js) so the UI thread never freezes during load or generation.

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

let worker = null;
let reqId = 0;
const pending = new Map(); // id -> { resolve, reject }

// Flips true once the worker confirms the model is loaded (either the proactive 'load' completes,
// or the first generation succeeds) — lets the UI stop counting the one-time ~90MB download into
// its time estimates once it's no longer relevant.
let modelWarm = false;

export function isModelWarm() {
  return modelWarm;
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        emitProgress(msg);
      } else if (msg.type === 'ready') {
        modelWarm = true;
      } else if (msg.type === 'result') {
        modelWarm = true;
        pending.get(msg.id)?.resolve(msg.blob);
        pending.delete(msg.id);
      } else if (msg.type === 'error') {
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id).reject(new Error(msg.message));
          pending.delete(msg.id);
        }
      }
    };
    worker.postMessage({ type: 'load' });
  }
  return worker;
}

// Generations are queued inside the worker itself (WASM must run one inference at a time) —
// this just tracks each in-flight request by id so its result finds its way back here.
export function generateSpeech(text, voice) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'generate', id, text, voice });
  });
}
