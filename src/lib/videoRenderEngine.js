// MP4 video rendering — extracted from ExportStep.jsx's renderVideo (pure refactor), following the
// same "no DOM dependency" pattern as thumbnailEngine.js. renderToMp4 (src/lib/exporter.js, itself
// unchanged) already creates and manages its own off-DOM <canvas> internally, so this module needs
// none of its own — its only job is assembling the same `items` shape ExportStep.jsx already built
// inline, then handing them to renderToMp4.
//
// This only covers the WebCodecs fast path (MP4). The WebM MediaRecorder fallback
// (triggered by WebCodecsUnsupportedError) stays in ExportStep.jsx: it fundamentally needs a live,
// DOM-mounted <canvas> to captureStream() from, which can't be made headless the way the fast path
// already is — callers should catch WebCodecsUnsupportedError (still exported by exporter.js,
// re-export not needed here) and fall back to that existing path themselves.
import { loadImage, decodeAudio } from './pollinations';
import { renderToMp4 } from './exporter';

/**
 * signal is accepted here (beyond the base project/settings/onProgress shape) so the existing
 * Cancel button (AbortController) keeps working — renderToMp4 already threads it straight through
 * to WebCodecs' own encoders.
 */
export async function renderVideoForExport(project, settings, { onProgress, signal } = {}) {
  const dims = settings.format === '9:16' ? { W: 720, H: 1280 } : { W: 1280, H: 720 };
  // content_type 'static_background' scenes have no `images` field at all (see App.jsx's
  // buildScenesFromRaw) — nothing to load beats from, drawFrame never reads `images` in this mode
  // either (see src/lib/engine.js), so it's simply never built.
  const isStaticBackground = settings.contentType === 'static_background';

  const items = await Promise.all(
    project.scenes.map(async (s) => ({
      images: isStaticBackground
        ? []
        : await Promise.all((s.images || []).map(async (beat) => ({ img: await loadImage(beat.url), animation: beat.animation }))),
      buffer: await decodeAudio(s.audioUrl),
      duration: (s.audioDuration || 0) + s.pad,
      narration: s.narration,
    }))
  );

  // project.staticBackground.url is a blob: URL — either still live from this session's own
  // generation, or already rebuilt by rehydrateProjectMedia (src/lib/mediaRehydration.js) from
  // imageStoragePath on resume. loadImage turns it into the HTMLImageElement drawFrame draws with.
  let staticBackground = null;
  if (isStaticBackground && project.staticBackground) {
    const bg = project.staticBackground;
    staticBackground =
      bg.type === 'image' && bg.url ? { type: 'image', img: await loadImage(bg.url) } : { type: 'color', color: bg.color || '#111111' };
  }

  return renderToMp4({
    items,
    width: dims.W,
    height: dims.H,
    subtitles: project.subtitles,
    staticBackground,
    textStyle: project.staticTextStyle,
    onProgress,
    signal,
  });
}
