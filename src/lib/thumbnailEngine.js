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

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function canvasToBlob(c) {
  if (typeof c.convertToBlob === 'function') return c.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Same telegraphic-vs-natural-language branching StoryboardStep.jsx's prompt builder uses for
// scene beats — Pollinations wants compact fragments, Nano Banana 2 / GPT Image 2 want full
// sentences. No character/reference anchoring here since thumbnails have no such selector.
function thumbnailPrompt(concept, overlayText, settings) {
  const flavoredPrompt = `${concept.image_prompt}, YouTube thumbnail style, bold colors, high contrast, dramatic, eye catching`;
  const style = STYLES[settings.style];
  const provider = settings.imageProvider || 'pollinations';
  if (provider === 'pollinations') {
    return buildTelegraphicPrompt({ scenePrompt: flavoredPrompt, styleSuffix: style.suffix });
  }
  // Premium providers bake the overlay text directly into the generated image instead of the
  // canvas overlay pollinations gets below — an explicit typography instruction steers them
  // toward something that reads like a real YouTube thumbnail rather than a generic caption.
  const textInstruction = `Include the exact text '${overlayText}' rendered directly in the image as bold, high-contrast YouTube thumbnail typography — thick sans-serif font, white or yellow fill with a black outline/drop shadow for readability, positioned in the lower third of the frame, sized large and impactful like professional YouTube thumbnails. The text must be spelled exactly as given, no alterations.`;
  return buildNaturalLanguagePrompt({ scenePrompt: `${flavoredPrompt}. ${textInstruction}`, styleDescription: style.natural });
}

/**
 * Generates the final 1280x720 thumbnail Blob for one concept from project.thumbnails.
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
export async function generateThumbnail(project, { settings, channelId, userId, videoId, thumbIdx = 0, overlayText = '', seed } = {}) {
  const concept = project.thumbnails[thumbIdx];
  const provider = settings.imageProvider || 'pollinations';

  // Same unified gateway (and the same server-side FAL_KEY auth) StoryboardStep.jsx already uses
  // for every scene beat — routes nanobanana/gptimage through fal.ai instead of always hitting
  // Pollinations regardless of the provider chosen for the rest of the video.
  const { imageUrl, costUsd } = await generateImage(thumbnailPrompt(concept, overlayText, settings), provider, [], {
    width: 1280,
    height: 720,
    seed,
    quality: 'medium',
  });
  // Real spend only — Pollinations always returns costUsd: 0, so nothing gets logged for it.
  if (costUsd > 0) await recordCost({ channelId, videoId, provider, type: 'image', amountUsd: costUsd });

  const img = await loadImage(imageUrl);
  const c = makeCanvas(1280, 720);
  const ctx = c.getContext('2d');
  // cover-fit
  const ir = img.width / img.height;
  const cr = 1280 / 720;
  let dw, dh;
  if (ir > cr) {
    dh = 720;
    dw = 720 * ir;
  } else {
    dw = 1280;
    dh = 1280 / ir;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1280, 720);
  ctx.drawImage(img, (1280 - dw) / 2, (720 - dh) / 2, dw, dh);

  if (provider === 'pollinations') {
    await document.fonts.ready;
    // bottom gradient for legibility
    const g = ctx.createLinearGradient(0, 380, 0, 720);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 380, 1280, 340);
    // overlay text
    const text = (overlayText || '').toUpperCase();
    const words = text.split(/\s+/).filter(Boolean);
    const lines =
      words.length > 2
        ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
        : [text];
    let size = 110;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const fit = (s) => {
      ctx.font = `800 ${s}px Syne, sans-serif`;
      return lines.every((ln) => ctx.measureText(ln).width < 1180);
    };
    while (size > 48 && !fit(size)) size -= 6;
    ctx.font = `800 ${size}px Syne, sans-serif`;
    const lineH = size * 1.08;
    lines.forEach((ln, i) => {
      const y = 720 - 56 - (lines.length - 1 - i) * lineH;
      ctx.lineWidth = size * 0.14;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000000';
      ctx.strokeText(ln, 640, y);
      ctx.fillStyle = i === lines.length - 1 ? '#FFD400' : '#FFFFFF';
      ctx.fillText(ln, 640, y);
    });
  }
  // Premium providers (nanobanana/gptimage) already baked the text into the generated image
  // itself (see thumbnailPrompt) — the cover-fit above is the only processing it needs.

  return canvasToBlob(c);
}
