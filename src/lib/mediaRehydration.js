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
 * real reload, since blob is always null by then. A beat with neither is left untouched (nothing to
 * rebuild — it was never generated, or never backed up).
 * Same logic for each scene's narration audio (audioBlob/audioUrl/audioStoragePath), and for
 * reference photos (file/storagePath).
 *
 * Never throws — a single failed download is logged and that one item is left as-is (its status
 * stays whatever it already was; this function only ever touches url/blob fields, never status).
 * Returns a new project object; the input is never mutated.
 */
export async function rehydrateProjectMedia(project) {
  const scenes = await Promise.all(
    (project.scenes || []).map(async (s) => {
      const images = await Promise.all(
        (s.images || []).map(async (im) => {
          if (im.blob) return { ...im, url: im.url || URL.createObjectURL(im.blob) };
          if (!im.storagePath) return im;
          try {
            const blob = await downloadMediaAsBlob(im.storagePath);
            return { ...im, blob, url: URL.createObjectURL(blob) };
          } catch (err) {
            console.error('[mediaRehydration] could not restore scene image from storage', im.storagePath, err);
            return im;
          }
        })
      );

      let audioBlob = s.audioBlob;
      let audioUrl = s.audioUrl;
      if (audioBlob) {
        audioUrl = audioUrl || URL.createObjectURL(audioBlob);
      } else if (s.audioStoragePath) {
        try {
          audioBlob = await downloadMediaAsBlob(s.audioStoragePath);
          audioUrl = URL.createObjectURL(audioBlob);
        } catch (err) {
          console.error('[mediaRehydration] could not restore scene audio from storage', s.audioStoragePath, err);
        }
      }

      return { ...s, images, audioBlob, audioUrl };
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

  return { ...project, scenes, references };
}
