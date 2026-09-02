// Shared "where should automation resume this video from" logic — used by both
// fullPipelineRecipe.js and staticBackgroundRecipe.js's resume check. Extends what used to be a
// Gemini-Batch-only mechanism (project.pendingImageBatches) to any phase a video can be left
// mid-way through after an interrupted browser session: suggestion/outline, scenes, media, render,
// thumbnail. YouTube publish is deliberately never auto-resumed — see determineResumePhase's own
// comment on why.

// Ordered from earliest to latest — used both to decide where to resume from and, via indexOf, to
// gate which of a recipe's phase blocks actually run on a resumed video (see shouldRunPhase below).
export const RESUME_PHASE_ORDER = ['suggestion', 'scenes', 'media', 'render', 'thumbnail'];

// A resume STATE, not a generation phase: everything up to and including the thumbnail is done and
// persisted, and the YouTube upload was never even started — the only thing left is a safe FIRST
// publish. Deliberately NOT in RESUME_PHASE_ORDER (no phase in that list should re-run for it);
// shouldRunPhase treats it exactly like null. Distinct from null so a fully-produced-but-unpublished
// video stays visible to findResumableVideo / listIncompleteVideos and a later automated cycle can
// finish it, instead of it vanishing from the resume system and needing a manual publish forever.
export const RESUME_PHASE_PUBLISH = 'publish';

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
 * project: the video's persisted project object (src/lib/db.js fromVideoRow's spread).
 * outline: project.outline, passed explicitly rather than read from `project` internally so this
 * function stays a pure, easily-testable inspection of whatever data it's handed. Only the
 * automation recipes' outline phase persists `outline`/`totalScenes`; the manual create flow
 * (App.jsx) never does — so its absence must NOT be read as "still at the suggestion phase" once
 * project.scenes already holds written scenes. outline/totalScenes are used only where a planned
 * total is genuinely needed (deciding whether scene writing is still unfinished).
 *
 * Returns one of RESUME_PHASE_ORDER's values, RESUME_PHASE_PUBLISH (everything produced, only a
 * first publish left), or null when there's nothing left for AUTOMATION to safely do on its own —
 * the video is already published, or a publish was already ATTEMPTED once (project.youtubeUploadStarted:
 * nothing in the record then distinguishes "the bytes never left" from "they reached Google before
 * the response was lost", and a duplicate public upload is worse than one video sitting for manual
 * review — see youtubePublishEngine.js's uploadVideo and the recipes' own 'youtube' phase,
 * deliberately not wrapped in network-retry for the same reason).
 */
export function determineResumePhase(project, outline) {
  // Truly terminal: already live on YouTube.
  if (project?.youtubeVideoId) return null;

  // A publish was already attempted for this video (the recipes persist youtubeUploadStarted right
  // before calling publishToYoutube). The upload may have reached Google before the response was
  // lost — never auto-resumed, left for manual review. This is the ONE "thumbnail is done" case
  // that must still resolve to null.
  if (project?.youtubeUploadStarted) return null;

  // Local-folder export mode (channel.automation_export_mode === 'local_folder', see
  // src/lib/localExport.js): the files were written out and the video deliberately stays "not
  // published" for a manual upload — terminal for automation, don't re-export it every cycle.
  if (project?.localExportedAt) return null;

  // Automation reached the publish phase and deliberately chose NOT to publish (auto-publish off for
  // the channel, or an anomalous mid-generation interruption held for manual review — the recipes'
  // YouTube phase persists project.publishSkipped { reason, at } before logging it). Terminal:
  // don't re-resume and re-log it every cycle. The dashboard surfaces publishSkipped.reason in
  // "Recently completed" so it's never a silent disappearance. A human publishes it from
  // Storyboard/Editor/Export, or clears publishSkipped to let automation retry.
  if (project?.publishSkipped) return null;

  // Media + thumbnail done, and publish was never even started — the only thing left is a safe first
  // publish. thumbnailStoragePath proves render succeeded too (the thumbnail phase always runs
  // strictly after render). The rendered MP4 itself is never persisted, so the recipe's resume
  // check re-renders it from the persisted images/audio before publishing.
  if (project?.thumbnailStoragePath) return RESUME_PHASE_PUBLISH;

  // A non-empty pendingImageBatches is unambiguous, strong evidence of genuinely being mid-media-
  // phase (Gemini Batch jobs submitted, not yet resolved) — checked before the outline/scenes checks
  // below so an older video missing those fields still correctly reports "waiting on a batch job"
  // instead of being misrouted all the way back to "suggestion".
  if (Array.isArray(project?.pendingImageBatches) && project.pendingImageBatches.length > 0) return 'media';

  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const totalScenes = Number(project?.totalScenes) || 0;
  const hasOutline = Array.isArray(outline) && outline.length > 0 && totalScenes > 0;

  // Nothing written yet: genuinely still early. 'scenes' if there's a plan to work from, otherwise
  // 'suggestion'. Once ANY scene exists, the outline phase is behind us — a manually-created video
  // never persists outline/totalScenes, so its written scenes are the only proof it got this far,
  // and their absence here must never regress it to "never started".
  if (scenes.length === 0) return hasOutline ? 'scenes' : 'suggestion';

  // Scene writing not finished — only decidable against a known planned total. Automation always
  // persists totalScenes; the manual flow never does, so a manual video with any scenes at all is
  // treated as past this phase, and the real per-scene media status below drives the rest.
  if (totalScenes > 0 && scenes.length < totalScenes) return 'scenes';

  // static_background videos have no per-beat images at all (see App.jsx/the recipes'
  // buildScenesFromRaw) — only narration audio needs to be ready for that content type.
  const isStaticBackground = !!project?.staticBackground;
  const mediaReady = scenes.every(
    (s) => s.audioStatus === 'ready' && (isStaticBackground || (s.images || []).every((im) => im.status === 'ready'))
  );
  if (!mediaReady) return 'media';

  // Media is ready and the thumbnail still needs making (a truthy thumbnailStoragePath was handled
  // above → RESUME_PHASE_PUBLISH). The rendered MP4 is never persisted, so resume always re-renders
  // from the persisted images/audio, then makes the thumbnail.
  return 'render';
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
// (nothing left automation can safely do) and RESUME_PHASE_PUBLISH (only the publish is left, and it
// runs unconditionally in the recipes — it isn't in RESUME_PHASE_ORDER) both skip every generation
// phase in RESUME_PHASE_ORDER.
export function shouldRunPhase(resumePhase, phase) {
  if (resumePhase === null || resumePhase === RESUME_PHASE_PUBLISH) return false;
  const startIndex = RESUME_PHASE_ORDER.indexOf(resumePhase);
  return RESUME_PHASE_ORDER.indexOf(phase) >= startIndex;
}
