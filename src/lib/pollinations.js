// Pollinations.ai — free image generation.
// Anonymous tier works without a key; an optional free token from enter.pollinations.ai
// can be saved in localStorage ('wisitube_polli_token') to lift rate limits.

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

// Kontext (image-to-image editing) needs a reference photo hosted on media.pollinations.ai first.
// The actual Pollinations secret key lives server-side only (api/pollinations-upload.js) — this
// just forwards the file to our own domain, same pattern as /api/generate.
export async function uploadReferenceImage(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/pollinations-upload', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ? `${body.error}${body.detail ? `: ${body.detail}` : ''}` : `Reference upload failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.url) throw new Error('Reference upload succeeded but returned no image reference');
  return data.url;
}

// Points at our own kontext proxy (api/pollinations-image.js) instead of Pollinations directly —
// that request also needs the server-side secret key, same reasoning as the upload above.
export function buildKontextImageUrl(prompt, referenceUrl, { width = 1280, height = 720, seed = 42 } = {}) {
  const params = new URLSearchParams({
    prompt,
    image: referenceUrl,
    width: String(width),
    height: String(height),
    seed: String(seed),
  });
  return `/api/pollinations-image?${params.toString()}`;
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
