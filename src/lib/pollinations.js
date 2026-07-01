// Pollinations.ai — free image generation + free TTS.
// Anonymous tier works without a key; an optional free token from enter.pollinations.ai
// can be saved in localStorage ('wisitube_polli_token') to lift rate limits.

export const VOICES = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'];

export const STYLES = {
  facestick: {
    label: 'Facestick',
    suffix:
      'simple stick figure characters with big expressive cartoon faces, childlike naive drawing, thick black marker outlines, flat plain background, minimal doodle illustration',
  },
  flat: {
    label: 'Flat Cartoon',
    suffix: 'flat vector cartoon illustration, bold simple shapes, modern 2D animation style, vibrant solid colors, clean composition',
  },
  doodle: {
    label: 'Notebook Doodle',
    suffix: 'hand drawn notebook doodle, sketchy black ink lines on white paper, playful rough sketch style',
  },
  watercolor: {
    label: 'Watercolor',
    suffix: 'soft watercolor storybook illustration, gentle pastel colors, dreamy painted texture',
  },
  comic: {
    label: 'Bold Comic',
    suffix: 'bold comic book illustration, thick outlines, dramatic lighting, halftone shading, saturated colors',
  },
};

function polliToken() {
  try {
    return localStorage.getItem('wisitube_polli_token') || '';
  } catch {
    return '';
  }
}

export function setPolliToken(v) {
  try {
    localStorage.setItem('wisitube_polli_token', v || '');
  } catch { /* ignore */ }
}

export function getPolliToken() {
  return polliToken();
}

export function buildImageUrl(prompt, { width = 1280, height = 720, seed = 42 } = {}) {
  const tk = polliToken();
  return (
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux&referrer=wisitube` +
    (tk ? `&token=${encodeURIComponent(tk)}` : '')
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readErrBody(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

async function blobFromAudioResponse(res, label) {
  if (!res.ok) {
    const body = await readErrBody(res);
    throw new Error(`TTS HTTP ${res.status} (${label}): ${body || res.statusText || 'no response body'}`);
  }
  const ct = res.headers.get('content-type') || '';
  const blob = await res.blob();
  if (!ct.includes('audio') && blob.size < 2000) {
    throw new Error(`TTS returned no audio (${label}, rate limit?)`);
  }
  return blob;
}

// Fetch TTS audio for a piece of narration. Returns a Blob (mp3).
export async function fetchTTS(text, voice = 'nova', { retries = 2 } = {}) {
  const tk = polliToken();
  const url =
    'https://text.pollinations.ai/' +
    encodeURIComponent(text) +
    `?model=openai-audio&voice=${encodeURIComponent(voice)}&referrer=wisitube` +
    (tk ? `&token=${encodeURIComponent(tk)}` : '');

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      return await blobFromAudioResponse(res, 'text.pollinations.ai');
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(2500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('TTS failed');
}

// ---- media caches (module-level, survive re-renders) ----
const imageCache = new Map(); // url -> Promise<HTMLImageElement>
const bufferCache = new Map(); // audioBlobUrl -> Promise<AudioBuffer>

export function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      imageCache.delete(url);
      reject(new Error('Image failed to load'));
    };
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

let sharedCtx = null;
function decodeCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AC();
  return sharedCtx;
}

export function decodeAudio(blobUrl) {
  if (bufferCache.has(blobUrl)) return bufferCache.get(blobUrl);
  const p = (async () => {
    const res = await fetch(blobUrl);
    const ab = await res.arrayBuffer();
    return await decodeCtx().decodeAudioData(ab);
  })();
  bufferCache.set(blobUrl, p);
  p.catch(() => bufferCache.delete(blobUrl));
  return p;
}
