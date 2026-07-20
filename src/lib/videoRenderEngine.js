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

  const items = await Promise.all(
    project.scenes.map(async (s) => ({
      images: await Promise.all(s.images.map(async (beat) => ({ img: await loadImage(beat.url), animation: beat.animation }))),
      buffer: await decodeAudio(s.audioUrl),
      duration: (s.audioDuration || 0) + s.pad,
      narration: s.narration,
    }))
  );

  return renderToMp4({
    items,
    width: dims.W,
    height: dims.H,
    subtitles: project.subtitles,
    onProgress,
    signal,
  });
}
