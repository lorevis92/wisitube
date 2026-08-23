// Rebuilds usable blob: object URLs for a project's scene images/audio (and reference photos) from
// their Supabase Storage backups — extracted from App.jsx's handleResume (manual resume), which
// needed this because blob: URLs (and the in-memory Blobs behind them) never survive a page reload:
// stripBlobsForSync (src/lib/db.js) replaces every Blob with null before every save, so whatever
// `url`/`audioUrl` string is left in a reloaded record is dead unless rebuilt from storagePath.
//
// Shared with fullPipelineRecipe.js's resume-an-incomplete-video path (see findResumableVideo)
// specifically because that same staleness applies there too: a video whose batch jobs finish
// across a browser restart has "ready" beats/audio with storagePath but no live blob: URL, and
// without this, render would silently fail (or produce broken output) trying to load them.
import { downloadMediaAsBlob } from './mediaStorage';

/**
 * project: any project object with .scenes (each with .images[] and audio fields) and optionally
 * .references — same shape App.jsx/fullPipelineRecipe.js/batchResumption.js already pass around.
 *
 * For each image beat: if it still has its in-memory Blob (same-session, never actually reloaded),
 * only fills in `url` if that's somehow missing. Otherwise, if it has a storagePath, downloads
 * fresh and rebuilds both blob and url — this is the path every field actually takes right after a
 * real reload, since blob is always null by then. A beat with neither is left untouched UNLESS its
 * status still says 'ready' — mediaGenerationEngine.js's generateBeatImage/generateSceneAudio set
 * status/audioStatus to 'ready' as soon as the in-memory blob exists, then attempt a Storage backup
 * as a separate, non-blocking step; if that backup fails (backupFailed/audioBackupFailed: true) no
 * storagePath is ever written, so a beat/scene that claims to be 'ready' but has neither a live blob
 * nor a storagePath to rebuild from is really carrying a dead blob: URL string that only looks fine
 * until something actually tries to load it. That case is downgraded to status/audioStatus: 'error'
 * with url/audioUrl: null and an explicit message, so every consumer (Storyboard, Editor, Export)
 * sees the same 'needs regeneration' signal it already knows how to handle for a hard generation
 * failure, instead of each having to separately guard against a URL that silently doesn't work.
 * A beat/scene that's still 'idle' (never attempted) or already 'error' or 'loading' is left as-is —
 * only the "looks ready but isn't" case is rewritten.
 * Same logic for each scene's narration audio (audioBlob/audioUrl/audioStoragePath), and for
 * reference photos (file/storagePath) — reference photos are untouched here since they don't carry a
 * status field consumers branch on the same way.
 *
 * Never throws — a single failed download is logged and that one item is left as-is (its status
 * stays whatever it already was; this function only downgrades status for the no-storagePath case
 * above, never on a download error, since that could just be a transient network blip against a
 * backup that's actually fine).
 * Returns a new project object; the input is never mutated.
 */
const LOST_IMAGE_MESSAGE = 'Lost — never backed up, regenerate this beat';
const LOST_AUDIO_MESSAGE = 'Lost — never backed up, regenerate this narration';

export async function rehydrateProjectMedia(project) {
  const scenes = await Promise.all(
    (project.scenes || []).map(async (s) => {
      const images = await Promise.all(
        (s.images || []).map(async (im) => {
          if (im.blob) return { ...im, url: im.url || URL.createObjectURL(im.blob) };
          if (im.storagePath) {
            try {
              const blob = await downloadMediaAsBlob(im.storagePath);
              return { ...im, blob, url: URL.createObjectURL(blob) };
            } catch (err) {
              console.error('[mediaRehydration] could not restore scene image from storage', im.storagePath, err);
              return im;
            }
          }
          if (im.status === 'ready') {
            return { ...im, status: 'error', url: null, blob: null, errorMessage: LOST_IMAGE_MESSAGE };
          }
          return im;
        })
      );

      let audioBlob = s.audioBlob;
      let audioUrl = s.audioUrl;
      let audioStatus = s.audioStatus;
      let audioError = s.audioError;
      if (audioBlob) {
        audioUrl = audioUrl || URL.createObjectURL(audioBlob);
      } else if (s.audioStoragePath) {
        try {
          audioBlob = await downloadMediaAsBlob(s.audioStoragePath);
          audioUrl = URL.createObjectURL(audioBlob);
        } catch (err) {
          console.error('[mediaRehydration] could not restore scene audio from storage', s.audioStoragePath, err);
        }
      } else if (audioStatus === 'ready') {
        audioStatus = 'error';
        audioUrl = null;
        audioError = LOST_AUDIO_MESSAGE;
      }

      return { ...s, images, audioBlob, audioUrl, audioStatus, audioError };
    })
  );

  // Only needed again if a beat anchored to a reference photo gets regenerated — restored here
  // rather than lazily, same as the manual flow.
  const references = await Promise.all(
    (project.references || []).map(async (r) => {
      if (r.file || !r.storagePath) return r;
      try {
        const file = await downloadMediaAsBlob(r.storagePath);
        return { ...r, file };
      } catch (err) {
        console.error('[mediaRehydration] could not restore reference photo from storage', r.storagePath, err);
        return r;
      }
    })
  );

  // content_type 'static_background' — same "blob nulled out by stripBlobsForSync, storagePath is
  // the durable copy" pattern as scene images/audio above, just a single project-level image
  // instead of one per beat.
  let staticBackground = project.staticBackground;
  if (staticBackground?.type === 'image') {
    if (staticBackground.blob) {
      staticBackground = { ...staticBackground, url: staticBackground.url || URL.createObjectURL(staticBackground.blob) };
    } else if (staticBackground.imageStoragePath) {
      try {
        const blob = await downloadMediaAsBlob(staticBackground.imageStoragePath);
        staticBackground = { ...staticBackground, blob, url: URL.createObjectURL(blob) };
      } catch (err) {
        console.error('[mediaRehydration] could not restore static background image from storage', staticBackground.imageStoragePath, err);
      }
    }
  }

  // Same "blob nulled out by stripBlobsForSync, storagePath is the durable copy" pattern — the
  // rendered MP4 (see the recipes' render phase, which now uploads it via uploadMedia the same way
  // thumbnails already were) so a resumed session can skip re-rendering entirely when only a later
  // phase (thumbnail/YouTube) was actually interrupted.
  let renderedVideoBlob = project.renderedVideoBlob;
  if (!renderedVideoBlob && project.renderedVideoStoragePath) {
    try {
      renderedVideoBlob = await downloadMediaAsBlob(project.renderedVideoStoragePath);
    } catch (err) {
      console.error('[mediaRehydration] could not restore rendered video from storage', project.renderedVideoStoragePath, err);
    }
  }

  return { ...project, scenes, references, staticBackground, renderedVideoBlob };
}
