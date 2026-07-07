// Pollinations.ai — free image generation.
// Anonymous tier works without a key; an optional free token from enter.pollinations.ai
// can be saved in localStorage ('wisitube_polli_token') to lift rate limits.

// Each style has two descriptions:
// - suffix: telegraphic fragments (12-15 words) for Pollinations/buildTelegraphicPrompt — leads
//   with a dominant, unambiguous description of the style, then explicitly negates whichever
//   neighboring style the image model is most likely to drift toward, since image models tend to
//   "average" toward more common, more detailed looks unless told not to.
// - natural: a discursive sentence for buildNaturalLanguagePrompt, used by the LLM-native premium
//   providers (Nano Banana 2 / GPT Image 2), which follow full natural instructions more reliably
//   than terse fragments.
export const STYLES = {
  facestick: {
    label: 'Facestick',
    suffix:
      "minimalist stick figure drawing, thin black line body like a child's drawing, simple round head with basic cartoon face, NOT a detailed cartoon character, no complex shading, flat plain background",
    natural:
      "Drawn as a minimalist stick-figure illustration — a thin black-line body with a simple round head and a basic cartoon face, like a child's doodle. Not a detailed or polished cartoon character, no shading, on a flat plain background.",
  },
  flat: {
    label: 'Flat Cartoon',
    suffix:
      'bold flat vector illustration, simple geometric shapes, solid flat colors, clean modern 2D animation style, NOT a stick figure, NOT photorealistic, no gradients or shading',
    natural:
      'Illustrated as a bold flat vector graphic — simple geometric shapes, solid flat colors, a clean modern 2D animation look. Not a stick figure, not photorealistic, no gradients or shading.',
  },
  doodle: {
    label: 'Notebook Doodle',
    suffix:
      'hand-drawn notebook doodle, sketchy black ink lines on plain white paper, rough playful pencil-and-paper sketch, NOT a clean vector illustration, NOT colored, no flat fills',
    natural:
      'Drawn as a hand-drawn notebook doodle — sketchy black ink lines on plain white paper, a rough and playful pencil-and-paper sketch. Not a clean vector illustration, not colored, no flat fills.',
  },
  watercolor: {
    label: 'Watercolor',
    suffix:
      'soft watercolor painting, gentle blended pastel colors, dreamy painterly texture, visible brush strokes, NOT flat vector colors, NOT thick black outlines',
    natural:
      'Painted as a soft watercolor illustration — gentle blended pastel colors, a dreamy painterly texture, visible brush strokes. Not flat vector colors, not thick black outlines.',
  },
  comic: {
    label: 'Bold Comic',
    suffix:
      'bold comic book illustration, thick black outlines, dramatic halftone shading, saturated dramatic colors, NOT flat pastel colors, NOT a soft watercolor look',
    natural:
      'Illustrated as a bold comic book panel — thick black outlines, dramatic halftone shading, saturated dramatic colors. Not flat pastel colors, not a soft watercolor look.',
  },
  iphone: {
    label: 'iPhone / UGC',
    suffix:
      'casual handheld iPhone photo, natural available light, slight motion blur, authentic amateur smartphone photography, no professional lighting',
    natural:
      'Shot like an authentic iPhone photo or video — handheld, casual framing, natural light, the unpolished look of real user-generated content, not a professional production.',
  },
  cinematic: {
    label: 'Cinematic',
    suffix:
      'cinematic film still, professional cinematography, shallow depth of field, dramatic natural lighting, color graded, high production value',
    natural:
      'Shot like a still from a well-produced narrative film — professional cinematography, thoughtful lighting and composition, shallow depth of field, color graded like a movie, high production value, clearly cinematic rather than amateur or AI-generated.',
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
