// Thumbnail generation — extracted verbatim from ExportStep.jsx's makeThumbnail (pure refactor).
// No behavior change: same per-provider prompt (typography baked into the generated image for
// premium providers, canvas text overlay for Pollinations), same cover-fit compositing, same
// cost-ledger write. The one real difference from the original — requested, not incidental — is
// that this function owns its own canvas (OffscreenCanvas when available, otherwise a detached
// <canvas> never inserted into the DOM) instead of reaching into a canvas ExportStep.jsx already
// has mounted. ExportStep.jsx draws the returned Blob onto its visible preview canvas afterward —
// the same thing it already does when restoring a thumbnail from Supabase Storage on resume, so
// the preview/download/YouTube-publish code paths that read from that canvas are unaffected.
//
// Supabase Storage backup (uploadMedia) and the project.thumbnailStoragePath update stay in
// ExportStep.jsx, not here: "returns the finished Blob, ready to upload" means this function's job
// ends at producing the pixels — where that Blob's bytes end up (Storage backup, later YouTube
// thumbnail upload via youtubePublishEngine.js) is the caller's concern, same separation of
// concerns mediaGenerationEngine.js draws between "generate" and "back up."
import { STYLES, loadImage } from './pollinations';
import { generateImage } from './sceneOrchestrator';
import { buildTelegraphicPrompt, buildNaturalLanguagePrompt } from './promptBuilders';
import { recordCost } from './db';
import { withTimeout } from './asyncTimeout';

// Neither generateImage (called directly here, not via mediaGenerationEngine's wrapped path) nor
// loadImage has a timeout of its own — a stalled provider response or a hung image download would
// otherwise freeze the recipe's thumbnail phase forever with no error. See src/lib/asyncTimeout.js.
const THUMBNAIL_GENERATE_TIMEOUT_MS = 150000; // provider call — api/generate-image maxDuration is 90s + margin
const THUMBNAIL_DOWNLOAD_TIMEOUT_MS = 45000; // <img> decode of the returned URL/data-URI

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

// JPEG, not PNG: YouTube caps thumbnails at 2 MB and rejects anything larger with an opaque
// HTTP 400 "invalidImage". A 1280x720 photo-real image as lossless PNG routinely hits 2–5 MB;
// the same frame as JPEG q0.9 is ~150–400 KB and the baked-in typography survives it fine. Same
// q0.9 for the 1080x1920 vertical Short thumbnail — still ~300–600 KB, well under the cap.
function canvasToBlob(c) {
  if (typeof c.convertToBlob === 'function') return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
}

// Per-format geometry. 16:9 values are chosen so every derived number (Math.round(dim * frac))
// reproduces the previous hard-coded layout EXACTLY — horizontal output is unchanged. 9:16 is a
// practical, light 1080x1920 canvas (well above YouTube's 640px minimum, far below a needless
// 2160x3840), with the pollinations text overlay sitting in the lower-middle rather than jammed at
// the very bottom, where a Short's own player chrome would cover it.
const FORMAT_SPEC = {
  '16:9': {
    canvasW: 1280,
    canvasH: 720,
    // image the provider generates — matches the canvas, so cover-fit is 1:1 (no scaling).
    genW: 1280,
    genH: 720,
    baseFontFrac: 110 / 1280, // → 110
    minFontFrac: 48 / 1280, // → 48
    // The pollinations text overlay used to sit jammed against the bottom edge — right where
    // YouTube ALWAYS paints the video-duration badge (bottom-right corner) and, on some mobile
    // layouts, a progress bar along the whole bottom edge. 'safe-center' keeps the whole text block
    // inside the real safe zone: horizontally centred, vertically centred a touch low, clamped so
    // nothing crosses ~15% from the top or ~22% from the bottom (extra clearance at the bottom for
    // the badge + progress bar). The darkening scrim is a soft band behind the text only, not the
    // whole lower half, so the image's subject stays visible.
    textLayout: 'safe-center',
    centerYFrac: 0.55,
    maxTextWidthFrac: 0.8, // 1280 * 0.8 ≈ 1024 → ~10% margin each side
    safeTopFrac: 0.15,
    safeBottomFrac: 0.22,
  },
  '9:16': {
    canvasW: 1080,
    canvasH: 1920,
    // 720x1280 keeps the provider call in the cheap resolution tier (same as a 9:16 scene beat) and
    // its aspect ratio equals the canvas's, so it's a clean uniform upscale with no crop.
    genW: 720,
    genH: 1280,
    // A Short's own thumbnail is only ever seen in the studio/feed, not under Shorts player chrome —
    // the lower-middle placement (well above the very bottom) already clears everything. Unchanged.
    textLayout: 'bottom',
    gradTopFrac: 0.44, // gradient covers the bottom ~56%
    textBottomFrac: 0.14, // text baseline ~270px up from the bottom, clear of the Short player chrome
    baseFontFrac: 96 / 1080,
    minFontFrac: 44 / 1080,
  },
};

// Explicit `format` opt wins; otherwise a Short is always vertical, otherwise the video's own
// settings.format, defaulting to horizontal.
function resolveThumbnailFormat({ format, project, settings }) {
  if (format === '9:16' || format === '16:9') return format;
  if (project?.isShort) return '9:16';
  return settings?.format === '9:16' ? '9:16' : '16:9';
}

// Same telegraphic-vs-natural-language branching StoryboardStep.jsx's prompt builder uses for
// scene beats — Pollinations wants compact fragments, Nano Banana 2 / GPT Image 2 want full
// sentences. No character/reference anchoring here since thumbnails have no such selector.
//
// Takes the effective provider (already translated from 'nanobanana-batch' to 'nanobanana' by the
// caller — see generateThumbnail below) rather than reading settings.imageProvider itself, so
// there's exactly one place that translation happens, not two.
function thumbnailPrompt(concept, overlayText, settings, effectiveProvider, fmt) {
  const orientation = fmt === '9:16' ? ' vertical 9:16 portrait composition,' : '';
  const flavoredPrompt = `${concept.image_prompt},${orientation} YouTube thumbnail style, bold colors, high contrast, dramatic, eye catching`;
  // settings.style can be missing entirely — e.g. an auto-generated Short's settings blob only
  // carries format/imageProvider (see shortsEngine.js), and App.jsx replaces the whole settings
  // object with the video record's blob on open. Fall back to the same default the recipes use
  // (DEFAULT_STYLE = 'facestick') rather than dereferencing STYLES[undefined].
  const style = STYLES[settings?.style] || STYLES.facestick;
  if (effectiveProvider === 'pollinations') {
    return buildTelegraphicPrompt({ scenePrompt: flavoredPrompt, styleSuffix: style.suffix });
  }
  // Premium providers bake the overlay text directly into the generated image instead of the
  // canvas overlay pollinations gets below — an explicit typography instruction steers them
  // toward something that reads like a real YouTube thumbnail rather than a generic caption.
  const textInstruction = `Include the exact text '${overlayText}' rendered directly in the image as bold, high-contrast YouTube thumbnail typography — thick sans-serif font, white or yellow fill with a black outline/drop shadow for readability, positioned in the lower ${
    fmt === '9:16' ? 'half' : 'third'
  } of the frame, sized large and impactful like professional YouTube thumbnails. The text must be spelled exactly as given, no alterations.`;
  return buildNaturalLanguagePrompt({ scenePrompt: `${flavoredPrompt}. ${textInstruction}`, styleDescription: style.natural });
}

/**
 * Generates the final thumbnail Blob for one concept from project.thumbnails — 1280x720 for a
 * horizontal video, 1080x1920 for a vertical Short (see resolveThumbnailFormat / the `format` opt).
 *
 * thumbIdx/overlayText/seed are accepted here (beyond the base project/settings/userId/videoId
 * shape) because the selected concept, its (possibly user-edited) overlay text, and its
 * regeneration seed are ExportStep's own UI state, never part of the saved project — the same
 * reasoning mediaGenerationEngine.js's generateBeatImage/generateSceneAudio already use for
 * accepting channelId beyond their nominal signature, needed here too for the cost-ledger write.
 * userId/videoId are accepted for signature parity with the other engine modules and potential
 * future use, but this function's own body doesn't need them — see the header comment above for
 * why the Storage backup they'd be used for stays in ExportStep.jsx.
 */
export async function generateThumbnail(project, { settings, channelId, userId, videoId, thumbIdx = 0, overlayText = '', seed, format } = {}) {
  // Every caller is SUPPOSED to hand us a real concept (the recipe checks plan.thumbnails[0], the
  // recipe's Short path backfills a synthetic one, ExportStep reads project.thumbnails). This is a
  // last-ditch guard so a record that still somehow has no concept produces a plain thumbnail
  // instead of a "Cannot read properties of undefined (reading 'image_prompt')" crash.
  const concept = (project.thumbnails || [])[thumbIdx] || {
    overlay_text: overlayText || '',
    image_prompt: `${project.titles?.[project.selectedTitle] || project.topic || 'the subject'}, one strong focal subject filling the frame, exaggerated emotion, high contrast, dramatic, no text in the image`,
  };
  const fmt = resolveThumbnailFormat({ format, project, settings });
  const spec = FORMAT_SPEC[fmt];
  const { canvasW: W, canvasH: H } = spec;
  const provider = settings.imageProvider || 'pollinations';
  // A thumbnail is a single image — never worth submitting to Gemini Batch and waiting up to
  // hours for it. 'nanobanana-batch' videos still get a real premium thumbnail, just via Nano
  // Banana 2's ordinary synchronous endpoint instead of the batch one. effectiveThumbnailProvider
  // is what actually drives generation (prompt branch, overlay decision, and the value sent to
  // generateImage/api/generate-image) — `provider` itself is kept around only in case it's ever
  // useful to log/trace which engine "family" this video's settings actually selected; it must
  // never reach the generation endpoint directly, which has no 'nanobanana-batch' case and — after
  // the api/generate-image.js fix — would now reject it outright instead of silently downgrading.
  const effectiveThumbnailProvider = provider === 'nanobanana-batch' ? 'nanobanana' : provider;

  // Same unified gateway (and the same server-side FAL_KEY auth) StoryboardStep.jsx already uses
  // for every scene beat — routes nanobanana/gptimage through fal.ai instead of always hitting
  // Pollinations regardless of the provider chosen for the rest of the video.
  const { imageUrl, costUsd } = await withTimeout(
    (signal) =>
      generateImage(
        thumbnailPrompt(concept, overlayText, settings, effectiveThumbnailProvider, fmt),
        effectiveThumbnailProvider,
        [],
        { width: spec.genW, height: spec.genH, seed, quality: 'medium' },
        signal
      ),
    THUMBNAIL_GENERATE_TIMEOUT_MS,
    `Thumbnail image generation (${effectiveThumbnailProvider})`
  );
  // Real spend only — Pollinations always returns costUsd: 0, so nothing gets logged for it.
  if (costUsd > 0) await recordCost({ channelId, videoId, provider: effectiveThumbnailProvider, type: 'image', amountUsd: costUsd });

  const img = await withTimeout(() => loadImage(imageUrl), THUMBNAIL_DOWNLOAD_TIMEOUT_MS, 'Thumbnail image download');
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  // cover-fit into W x H
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
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  if (effectiveThumbnailProvider === 'pollinations') {
    await document.fonts.ready;

    const text = (overlayText || '').toUpperCase();
    const words = text.split(/\s+/).filter(Boolean);
    const lines =
      words.length > 2
        ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
        : [text];
    const baseSize = Math.round(W * spec.baseFontFrac);
    const minSize = Math.round(W * spec.minFontFrac);
    const maxTextWidth = spec.maxTextWidthFrac ? Math.round(W * spec.maxTextWidthFrac) : W - 100;
    let size = baseSize;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const fit = (s) => {
      ctx.font = `800 ${s}px Syne, sans-serif`;
      return lines.every((ln) => ctx.measureText(ln).width < maxTextWidth);
    };
    while (size > minSize && !fit(size)) size -= 6;
    ctx.font = `800 ${size}px Syne, sans-serif`;
    const lineH = size * 1.08;

    // Per-line baseline Y.
    let baselines;
    if (spec.textLayout === 'safe-center') {
      // Approximate cap height / descent for the alphabetic baseline, so the *visual* block can be
      // clamped into the safe band rather than the baselines themselves.
      const ascent = size * 0.72;
      const descent = size * 0.2;
      const safeTop = Math.round(H * spec.safeTopFrac);
      const safeBottom = Math.round(H - H * spec.safeBottomFrac);
      // b0 that puts the block's visual centre at centerYFrac.
      let b0 = Math.round(H * spec.centerYFrac) - ((lines.length - 1) * lineH) / 2 + (ascent - descent) / 2;
      // Clamp so the visual top/bottom stay inside [safeTop, safeBottom].
      b0 = Math.max(safeTop + ascent, Math.min(safeBottom - descent - (lines.length - 1) * lineH, b0));
      baselines = lines.map((_, i) => Math.round(b0 + i * lineH));
    } else {
      // 9:16: bottom-anchored, unchanged.
      const bottomMargin = Math.round(H * spec.textBottomFrac);
      baselines = lines.map((_, i) => H - bottomMargin - (lines.length - 1 - i) * lineH);
    }

    // Legibility scrim.
    if (spec.textLayout === 'safe-center') {
      // A soft dark band behind the text only — top and bottom of the image stay clear.
      const bandTop = Math.min(...baselines) - size * 0.9;
      const bandBottom = Math.max(...baselines) + size * 0.35;
      const feather = Math.round(H * 0.11);
      const g = ctx.createLinearGradient(0, bandTop - feather, 0, bandBottom + feather);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.3, 'rgba(0,0,0,0.6)');
      g.addColorStop(0.7, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, bandTop - feather, W, bandBottom + feather - (bandTop - feather));
    } else {
      const gradTop = Math.round(H * spec.gradTopFrac);
      const g = ctx.createLinearGradient(0, gradTop, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(0, gradTop, W, H - gradTop);
    }

    lines.forEach((ln, i) => {
      const y = baselines[i];
      ctx.lineWidth = size * 0.14;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000000';
      ctx.strokeText(ln, W / 2, y);
      ctx.fillStyle = i === lines.length - 1 ? '#FFD400' : '#FFFFFF';
      ctx.fillText(ln, W / 2, y);
    });
  }
  // Premium providers (nanobanana/gptimage) already baked the text into the generated image
  // itself (see thumbnailPrompt) — the cover-fit above is the only processing it needs.

  return canvasToBlob(c);
}
