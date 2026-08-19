// Shared "where should automation resume this video from" logic — used by both
// fullPipelineRecipe.js and staticBackgroundRecipe.js's resume check. Extends what used to be a
// Gemini-Batch-only mechanism (project.pendingImageBatches) to any phase a video can be left
// mid-way through after an interrupted browser session: suggestion/outline, scenes, media, render,
// thumbnail. YouTube publish is deliberately never auto-resumed — see determineResumePhase's own
// comment on why.

// Ordered from earliest to latest — used both to decide where to resume from and, via indexOf, to
// gate which of a recipe's phase blocks actually run on a resumed video (see shouldRunPhase below).
export const RESUME_PHASE_ORDER = ['suggestion', 'scenes', 'media', 'render', 'thumbnail'];

// A video stuck failing the exact same phase this many times in a row is presumed systematically
// broken (a bad prompt, a persistently failing provider, corrupted state) rather than transiently
// unlucky — seeAdvance trackResumeAttempt below. Retrying it forever would quietly burn quota/spend
// every single cycle without ever producing anything.
export const MAX_RESUME_ATTEMPTS = 5;

// How long a video stays eligible for automatic resumption at all, regardless of which phase it's
// stuck at — past this it's left for manual review rather than silently retried cycle after cycle.
// Wider than the old Gemini-Batch-only 48h window (batch jobs were the only reason a video could be
// mid-flight before this feature): a video can now be interrupted at ANY phase by the same "browser
// tab must stay open" constraint the scheduler itself has, so this needs to comfortably cover a
// multi-day gap (a weekend the computer was off, say), not just one batch job's turnaround.
export const RESUMABLE_VIDEO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * project: the video's persisted project object (src/lib/db.js fromVideoRow's spread) — must
 * include `outline`/`totalScenes` if scene generation ever got that far (see the outline phase in
 * both recipes, which now persists them alongside the rest of the outline's output specifically so
 * a resumed session can inspect them here).
 * outline: project.outline, passed explicitly rather than read from `project` internally so this
 * function stays a pure, easily-testable inspection of whatever data it's handed.
 *
 * Returns one of RESUME_PHASE_ORDER's values, or null when there's nothing left for AUTOMATION to
 * safely do on its own — thumbnail is done and either the video is already published (the caller's
 * concern: check project.youtubeVideoId before even calling this) or publish is the only remaining
 * step, which is intentionally never auto-resumed: nothing in the persisted record distinguishes
 * "never attempted" from "attempted, but the response was lost mid-upload" (see
 * youtubePublishEngine.js's uploadVideo and the recipes' own 'youtube' phase — deliberately not
 * wrapped in network-retry either, for the exact same reason), and a duplicate public upload is a
 * strictly worse outcome than one video sitting for manual review.
 */
export function determineResumePhase(project, outline) {
  const totalScenes = Number(project?.totalScenes) || 0;
  const hasOutline = Array.isArray(outline) && outline.length > 0 && totalScenes > 0;
  if (!hasOutline) return 'suggestion';

  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  if (scenes.length < totalScenes) return 'scenes';

  // static_background videos have no per-beat images at all (see App.jsx/the recipes'
  // buildScenesFromRaw) — only narration audio needs to be ready for that content type.
  const isStaticBackground = !!project?.staticBackground;
  const mediaReady = scenes.every(
    (s) => s.audioStatus === 'ready' && (isStaticBackground || (s.images || []).every((im) => im.status === 'ready'))
  );
  if (!mediaReady) return 'media';

  if (!project?.renderedVideoStoragePath) return 'render';
  if (!project?.thumbnailStoragePath) return 'thumbnail';

  return null;
}

/**
 * Compares this resume attempt's phase against the phase recorded from the LAST resume attempt
 * (project.lastResumePhase) to decide whether real progress happened since then. Landing on the
 * SAME phase again means every attempt since it was first recorded there failed to move forward —
 * increments the counter. Landing on a LATER phase means the last attempt actually succeeded —
 * resets to 1 (this is now the first attempt at the new phase).
 *
 * Returns { attempts, stuck } — stuck is true once attempts exceeds MAX_RESUME_ATTEMPTS, meaning
 * this specific phase has now failed MAX_RESUME_ATTEMPTS times in a row and should NOT be retried
 * again automatically. Callers should persist { resumeAttempts: attempts, lastResumePhase: resumePhase }
 * onto the video record BEFORE actually attempting the phase again (not after), so a crash during
 * that very attempt still gets counted correctly on the next resume.
 */
export function trackResumeAttempt(project, resumePhase) {
  const previousPhase = project?.lastResumePhase || null;
  const attempts = resumePhase === previousPhase ? (Number(project?.resumeAttempts) || 0) + 1 : 1;
  return { attempts, stuck: attempts > MAX_RESUME_ATTEMPTS };
}

// True when `phase` is at-or-after the phase automation should resume from — used to gate each of a
// recipe's phase blocks (`if (shouldRunPhase(resumePhase, 'scenes')) { ... }`). resumePhase === null
// (nothing left automation can safely do — see determineResumePhase) means every phase in
// RESUME_PHASE_ORDER is skipped.
export function shouldRunPhase(resumePhase, phase) {
  if (resumePhase === null) return false;
  const startIndex = RESUME_PHASE_ORDER.indexOf(resumePhase);
  return RESUME_PHASE_ORDER.indexOf(phase) >= startIndex;
}
