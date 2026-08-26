// Full pipeline recipe for the automation engine — Phase 2a: real generation, composing the same
// engine modules the manual UI already uses (mediaGenerationEngine.js, videoRenderEngine.js,
// thumbnailEngine.js, youtubePublishEngine.js, sceneOrchestrator.js). No new generation logic lives
// here — this file only sequences existing, already-exercised building blocks and persists the
// video record at each checkpoint, so a failure partway leaves a resumable record behind for manual
// review in the regular Storyboard/Editor/Export UI instead of vanishing.
//
// A video interrupted partway (browser tab closed, computer slept, any crash — not just Gemini
// Batch's own async turnaround) is picked back up from wherever it actually left off — suggestion/
// outline, scenes, media, render, or thumbnail — via findResumableVideo + determineResumePhase (see
// src/lib/videoResumption.js), NOT restarted from scratch. YouTube publish auto-resumes ONLY when
// it's provably a safe first attempt (normal Gemini Batch wait, or fully produced with the upload
// never started — see the 'youtube' phase below); a genuine anomalous interruption mid-generation
// still stops for manual review. A video stuck failing the same phase MAX_RESUME_ATTEMPTS times in
// a row is marked permanently stuck rather than retried forever.
//
// Every phase logs exactly once via the injected logStep(channelId, videoId, step, status,
// message) — 'success' on completion, 'error' right before re-throwing — and a failure in any
// phase stops the whole recipe immediately: later phases never run against an incomplete video.
import { createId, saveVideo, loadVideo, listVideosByChannel, getCostsByChannel } from '../db';
import { uploadMedia, downloadMediaAsBlob } from '../mediaStorage';
import { generateAllScenes } from '../sceneOrchestrator';
import { generateAllMedia } from '../mediaGenerationEngine';
import { generateAllMediaViaBatch } from '../geminiBatchImageEngine';
import { resumePendingBatches } from '../batchResumption';
import { rehydrateProjectMedia } from '../mediaRehydration';
import { isCreditExhaustedMessage } from '../providerErrors';
import { renderVideoForExport } from '../videoRenderEngine';
import { generateThumbnail } from '../thumbnailEngine';
import { publishToYoutube } from '../youtubePublishEngine';
import { getTopicSuggestions, startTopicSuggestion } from '../contentProgramManager';
import { determineResumePhase, trackResumeAttempt, shouldRunPhase, RESUME_PHASE_PUBLISH, RESUMABLE_VIDEO_WINDOW_MS, MAX_RESUME_ATTEMPTS } from '../videoResumption';
import { STYLES } from '../pollinations';
import { MINIMAX_VOICES } from '../voiceProviders';

// Finds the most recent video on this channel that isn't in a terminal state — published
// (youtubeVideoId set) or explicitly abandoned (stuckError set, see the resume-attempt tracking
// below) — and that still has something automation can safely do next (determineResumePhase !==
// null; that includes RESUME_PHASE_PUBLISH — a fully produced video whose upload was never started —
// but excludes a video whose upload WAS already attempted). Used to be Gemini-Batch-only (only ever
// found something via pendingImageBatches); now covers a video interrupted at any phase, since the
// same "browser tab must stay open" constraint that scheduler resumption has to work around applies
// here too.
async function findResumableVideo(channelId) {
  const videos = await listVideosByChannel(channelId);
  const cutoff = Date.now() - RESUMABLE_VIDEO_WINDOW_MS;
  return (
    videos.find((v) => {
      if ((v.createdAt || 0) < cutoff) return false;
      if (v.youtubeVideoId) return false; // already published — terminal
      if (v.stuckError) return false; // explicitly abandoned after MAX_RESUME_ATTEMPTS — terminal
      return determineResumePhase(v, v.outline) !== null;
    }) || null
  );
}

// Sums the cost-ledger entries (recordCost, written from mediaGenerationEngine.js/
// thumbnailEngine.js/batchResumption.js) for one specific video — used both for the final return
// and for the early "still in progress" return, since a batch-provider video can genuinely have
// spent money (on whatever images a batch already resolved) before its images are all ready.
async function totalCostForVideo(channelId, videoId) {
  const { items: costItems } = await getCostsByChannel(channelId);
  return costItems.filter((c) => c.videoId === videoId).reduce((sum, c) => sum + (c.amountUsd || 0), 0);
}

let sceneIdCounter = 1;
let beatIdCounter = 1;

const NETWORK_WAIT_POLL_MS = 30000;
const NETWORK_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Same detection heuristic as mediaGenerationEngine.js's own copy (a real network drop, not an
// application error) — duplicated rather than shared since this file already duplicates other
// small, stable constants from elsewhere (YOUTUBE_LANGUAGE_CODES below) and no shared
// network-error-classification module exists yet.
function isNetworkError(err) {
  if (err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '');
  return /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK/i.test(msg);
}

// Polls navigator.onLine every 30s until it's true or NETWORK_WAIT_TIMEOUT_MS has elapsed.
// Resolves immediately (true) if already online — a transient blip that already cleared by the
// time this runs shouldn't cost a 30s wait.
async function waitForOnline() {
  const deadline = Date.now() + NETWORK_WAIT_TIMEOUT_MS;
  while (!navigator.onLine) {
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, NETWORK_WAIT_POLL_MS));
  }
  return true;
}

/**
 * Runs one recipe phase (phaseFn). mediaGenerationEngine.js/sceneOrchestrator.js already retry an
 * individual network call a few times on their own — this is the outer, whole-phase-level
 * fallback for when a Wi-Fi drop outlasts all of that: if phaseFn still fails with a network
 * error, wait for the browser to report itself back online (polling every 30s, capped at 10
 * minutes) and retry the ENTIRE phase exactly once more. Any other failure (an application error,
 * or a second network failure after that one retry) propagates immediately — this is a single
 * extra chance, not an unbounded loop, so one channel's connectivity problem can't stall the whole
 * automation cycle.
 */
async function withPhaseNetworkResilience(phaseName, channelId, videoId, logStep, phaseFn) {
  try {
    return await phaseFn();
  } catch (err) {
    if (!isNetworkError(err)) throw err;

    if (!navigator.onLine) {
      await logStep(channelId, videoId, phaseName, 'retrying', 'network unavailable — waiting for connection to return (up to 10 min)');
      const cameBack = await waitForOnline();
      if (!cameBack) throw new Error('network unavailable for over 10 minutes');
    }

    await logStep(channelId, videoId, phaseName, 'retrying', `network error, retrying phase once: ${err.message}`);
    return await phaseFn();
  }
}

// Same transform App.jsx's buildScenesFromRaw performs on api/generate-scenes.js's raw output —
// duplicated here rather than imported (App.jsx is a React component, not a shared module; this is
// a pure data transform with no framework dependency). Its own counters are separate from App.jsx's
// — fine, since scene/beat ids only ever need to be unique within the one project they belong to,
// never compared across videos or across this file vs. App.jsx's copy.
function buildScenesFromRaw(rawScenes) {
  return (rawScenes || []).map((s) => {
    const beats = Array.isArray(s.image_beats) && s.image_beats.length ? s.image_beats.slice(0, 2) : [{}, {}];
    while (beats.length < 2) beats.push({});
    return {
      id: sceneIdCounter++,
      narration: s.narration || '',
      images: beats.map((b) => ({
        id: beatIdCounter++,
        prompt: b.image_prompt || '',
        animation: b.animation || 'zoom_in',
        referenceId: b.reference_id || null,
        characterId: b.character_id || null,
        variantLabel: b.variant_label || null,
        seed: Math.floor(Math.random() * 999999),
        status: 'idle',
        url: '',
        blob: null,
      })),
      pad: 0.3,
      audioStatus: 'idle',
      audioUrl: '',
      audioBlob: null,
      audioDuration: 0,
    };
  });
}

// Applies one mediaGenerationEngine.js/batchResumption.js onProgress event to a local project copy
// — the same per-beat/per-scene patch shape StoryboardStep.jsx's updateImage/updateScene apply to
// React state. Needed here because generateAllMedia/resumePendingBatches only report through
// onProgress (there's no React state to read back from in a headless caller), and this recipe has
// to know the final per-beat/per-scene status afterward to detect partial failures those don't
// throw for on their own (a single failed beat just stays 'error', silently).
//
// Number(evt.sceneId) here is defense-in-depth, not the primary fix: project.scenes[].id is always
// a number, and geminiBatchImageEngine.js's parseBeatKey now converts to a number at its own
// source, so evt.sceneId should already be numeric by the time it gets here. But this function has
// no way to know which emitter a given event came from, and the exact same silent-no-match failure
// (a string sceneId compared with === against a numeric scene.id) would recur here even if some
// future onProgress source ever forgot that conversion — so it's coerced again on the way in.
function applyMediaProgress(project, evt) {
  if (evt.kind === 'beat') {
    const sceneId = Number(evt.sceneId);
    return {
      ...project,
      scenes: project.scenes.map((s) =>
        s.id === sceneId ? { ...s, images: s.images.map((im, i) => (i === evt.beatIndex ? { ...im, ...evt.patch } : im)) } : s
      ),
    };
  }
  if (evt.kind === 'scene') {
    const sceneId = Number(evt.sceneId);
    return { ...project, scenes: project.scenes.map((s) => (s.id === sceneId ? { ...s, ...evt.patch } : s)) };
  }
  return project;
}

// Scans a project's per-beat/per-scene media state for a recognized "credit exhausted" failure
// (the 💳-marked message the api/ endpoints and providerErrors.js produce), so the media phase can
// log that specific cause with its own distinct status instead of the generic "some scenes failed
// to generate media". Returns the message of the first one found, or null.
function findCreditExhaustedError(project) {
  for (const s of project.scenes || []) {
    if (s.audioStatus === 'error' && isCreditExhaustedMessage(s.audioError)) return s.audioError;
    for (const im of s.images || []) {
      if (im.status === 'error' && isCreditExhaustedMessage(im.errorMessage)) return im.errorMessage;
    }
  }
  return null;
}

// Style/language/format/voice/YouTube category/made-for-kids are all configurable per channel now
// (see buildAutomationSettings and the YouTube phase's metadata below) — these constants are just
// fallback values for channels that were created before a given field existed.
const DEFAULT_STYLE = 'facestick';
const DEFAULT_LANGUAGE = 'English';
const DEFAULT_FORMAT = '16:9';
const DEFAULT_KOKORO_VOICE = 'af_heart';
const DEFAULT_YOUTUBE_CATEGORY_ID = '27'; // Education

// Same mapping as ExportStep.jsx's own local constant — duplicated rather than imported since
// ExportStep.jsx doesn't export it (small, stable, controlled-duplication pattern already used
// elsewhere in this codebase).
const YOUTUBE_LANGUAGE_CODES = { English: 'en', Italiano: 'it', Español: 'es', Français: 'fr', Deutsch: 'de' };

function buildAutomationSettings(channel) {
  const voiceEngine = channel.automation_voice_engine || 'kokoro';
  // channel.automation_voice is configurable per channel (AutomationStep.jsx) — only fall back to
  // the engine's own default when it's empty (channels created before this field existed).
  const voice = channel.automation_voice || (voiceEngine === 'minimax' ? MINIMAX_VOICES[0].id : DEFAULT_KOKORO_VOICE);
  return {
    style: channel.automation_style || DEFAULT_STYLE,
    language: channel.automation_language || DEFAULT_LANGUAGE,
    format: channel.automation_format || DEFAULT_FORMAT,
    imageProvider: channel.automation_image_provider || 'pollinations',
    voiceEngine,
    voice,
    speechSpeed: Number(channel.automation_speech_speed) || 1.0,
    lengthMinutes: Number(channel.automation_length_minutes) || 5,
  };
}

/**
 * channel: the full channel record (src/lib/db.js fromChannelRow) — must have automation_* fields
 * populated and be YouTube-connected for the final publish phase to succeed.
 * userId: the authenticated user running this cycle — needed by the media/thumbnail engines for
 * Supabase Storage paths and cost-ledger writes.
 * onProgress({ step, message }): optional, for high-frequency sub-phase progress (e.g. "12/40
 * scenes written", upload %) that would be excessive to persist as individual logStep rows.
 * logStep(channelId, videoId, step, status, message): injected rather than imported from
 * automationEngine.js, since automationEngine.js is the one that imports this file — importing it
 * back would be circular.
 *
 * Returns { videoId, youtubeVideoId, costUsd, inProgress } — inProgress is true when this call
 * ends with Gemini Batch jobs still outstanding for this video's images (nothing failed, there's
 * just nothing left to do until Google finishes them — see automationEngine.js, which treats this
 * as neither a completed video nor an error). inProgress is false (the pre-existing contract) once
 * a video is genuinely done, whether that took one call or several resumed ones. youtubeVideoId is
 * null when auto-publish is off, and when the video was resumed after an anomalous mid-generation
 * interruption (NOT for a normal Gemini Batch wait or a safe ready-to-publish resume — those still
 * publish; see the YouTube phase below) — check project.stuckError separately for "gave up after
 * MAX_RESUME_ATTEMPTS", which throws rather than returning normally (see below).
 *
 * Throws on the first phase failure that ISN'T "batch jobs still running", INCLUDING a resumed
 * video that's failed the exact same phase MAX_RESUME_ATTEMPTS times in a row (marked with
 * project.stuckError first, so findResumableVideo excludes it from now on — see
 * src/lib/videoResumption.js). Whatever was saved via saveVideo up to that point stays on the
 * record for manual review in the regular Storyboard/Editor/Export UI — nothing is rolled back or
 * deleted.
 */
// targetVideoId: optional — set by AutomationMirrorStep.jsx's "Resume now" button to resume this
// EXACT video instead of letting findResumableVideo pick whichever resumable one it finds for the
// channel. Skips the 7-day RESUMABLE_VIDEO_WINDOW_MS cutoff too (that's a safety net for the blind,
// automatic search — an explicit human choosing a specific video from the dashboard doesn't need
// it) and, since this is a single-video action rather than a whole cycle, is never routed through
// runManagedCycle/the currently_running lock — the caller invokes this recipe directly.
export async function runFullPipeline(channel, { userId, onProgress, logStep, targetVideoId } = {}) {
  const channelId = channel.id;
  const settings = buildAutomationSettings(channel);
  // Declared here (rather than at their original spot further down) so report()/persist() can
  // close over them from the very first call — all populated either by the resume branch below or
  // by the suggestion/video-record/outline/scenes phases for a brand-new video.
  let videoId = null;
  let project = null;
  let plan = null;
  let suggestion = null;
  let createdAt = Date.now();
  const report = (step, message) => onProgress?.({ step, message, videoId, project });

  // Shared by every persist() call in this function, whether resuming or starting fresh — reads
  // whatever videoId/project/plan/suggestion/createdAt are in scope at call time.
  const persist = () =>
    saveVideo({
      id: videoId,
      channelId,
      createdAt,
      updatedAt: Date.now(),
      topic: suggestion?.title,
      settings,
      ...project,
      displayTitle: plan?.title || suggestion?.title,
    });

  // ---- Resume check ----
  // Covers a video interrupted at ANY phase (suggestion/outline, scenes, media, render, thumbnail —
  // see src/lib/videoResumption.js), not just Gemini Batch's own pending jobs. resumePhase drives
  // which of the phase blocks below actually run: 'suggestion' means "nothing usable saved yet, run
  // everything" — a brand-new (non-resumed) video takes that exact same path by default below.
  const resumable = targetVideoId ? await loadVideo(targetVideoId) : await findResumableVideo(channelId);
  let resumePhase = 'suggestion';
  const wasResumed = !!resumable;
  // wasResumed alone is too blunt to gate auto-publish on (see the YouTube phase): it's true for the
  // entirely normal "submit Gemini Batch → wait → resume" flow — a nanobanana-batch video is ALWAYS
  // resumed at least once, since the submitting call returns inProgress:true without ever rendering.
  // Two narrower signals separate that (and a safe ready-to-publish resume) from a genuine anomalous
  // mid-generation interruption:
  //   resumedFromNormalBatchWait — this resume picked the video up specifically because it still had
  //     Gemini Batch jobs outstanding (resumable.pendingImageBatches non-empty).
  //   resumedReadyToPublish — media/render/thumbnail all done AND the YouTube upload was never even
  //     started (determineResumePhase → RESUME_PHASE_PUBLISH, which already excludes
  //     project.youtubeUploadStarted), so publishing now is provably a safe first attempt.
  let resumedFromNormalBatchWait = false;
  let resumedReadyToPublish = false;

  if (resumable) {
    videoId = resumable.id;
    createdAt = resumable.createdAt || Date.now();
    // blob: URLs never survive a reload — a beat/audio/rendered-video that finished on an earlier
    // cycle (in a browser session that's since closed) has a storagePath but a dead url/blob.
    // Rehydrating here, before anything below checks readiness or touches media/render/thumbnail/
    // YouTube, means those phases always see valid, loadable media regardless of which session each
    // piece was actually completed in.
    project = await rehydrateProjectMedia(resumable);
    plan = {
      title: resumable.displayTitle || resumable.topic || '',
      description: resumable.description || '',
      tags: resumable.tags || [],
      thumbnails: resumable.thumbnails || [],
      characterBible: resumable.characterBible || [],
      references: resumable.references || [],
      outline: resumable.outline || [],
      totalScenes: resumable.totalScenes || 0,
    };
    suggestion = { title: resumable.topic || plan.title, series: resumable.series || null };
    const rawResumePhase = determineResumePhase(project, plan.outline);
    resumePhase = rawResumePhase;
    resumedFromNormalBatchWait = Array.isArray(resumable.pendingImageBatches) && resumable.pendingImageBatches.length > 0;
    resumedReadyToPublish = rawResumePhase === RESUME_PHASE_PUBLISH;

    // Safety net: determineResumePhase says render/thumbnail already happened based on a storage
    // path being present, but the actual Storage download (rehydrateProjectMedia above) can itself
    // fail — never proceed past render as if a usable video blob exists when it doesn't. (The
    // resumedReadyToPublish flag stays set even when this downgrades the phase: publishing is still
    // safe once the re-render + existing-thumbnail restore below finish.)
    if ((resumePhase === 'thumbnail' || resumePhase === RESUME_PHASE_PUBLISH || resumePhase === null) && !project.renderedVideoBlob) resumePhase = 'render';

    // A video stuck failing the exact same phase over and over (a systematic problem — a bad
    // prompt, a persistently failing provider, corrupted state) would otherwise retry forever,
    // quietly burning quota/spend every cycle. Recorded and checked BEFORE this attempt actually
    // runs, so a crash during this very attempt still gets counted correctly on the next resume.
    const { attempts, stuck } = trackResumeAttempt(project, resumePhase);
    project = { ...project, resumeAttempts: attempts, lastResumePhase: resumePhase };

    if (stuck) {
      const stuckMessage = `⚠ Stuck after ${MAX_RESUME_ATTEMPTS} automatic resume attempts in the "${resumePhase}" phase — needs manual review`;
      project = { ...project, stuckError: stuckMessage };
      await persist();
      await logStep(channelId, videoId, resumePhase, 'error', stuckMessage);
      throw new Error(stuckMessage);
    }

    await persist();
    await logStep(
      channelId,
      videoId,
      'resume',
      'success',
      `resuming incomplete video "${plan.title}" from the "${resumePhase}" phase (attempt ${attempts}/${MAX_RESUME_ATTEMPTS})`
    );
    report('resume', `Resuming "${plan.title}" — continuing from ${resumePhase}`);
  }

  if (shouldRunPhase(resumePhase, 'suggestion')) {
    // ---- Phase: suggestion ----
    try {
      suggestion = await withPhaseNetworkResilience('suggestion', channelId, null, logStep, async () => {
        const existingVideos = await listVideosByChannel(channelId);
        // Same cached, scored suggestion pool ChannelDashboardStep.jsx's panel reads from (see
        // src/lib/contentProgramManager.js) — within the 24h cache window this is a free read, no
        // new Claude/Trends/YouTube calls at all.
        const { channel: scoredChannel, finalSuggestions } = await getTopicSuggestions(channel, { videos: existingVideos });
        if (!finalSuggestions.length) throw new Error('Content Program Manager returned no suggestions');
        const picked = finalSuggestions.find((s) => s.priority === 'high') || finalSuggestions[0];
        // Same mechanism as ChannelDashboardStep.jsx's "Start this video" — removes `picked` from
        // the shared cached list and backfills it, so the dashboard stops showing an idea this
        // automation cycle just committed to as a real video.
        await startTopicSuggestion(scoredChannel, picked, existingVideos);
        return picked;
      });
      await logStep(
        channelId,
        null,
        'suggestion',
        'success',
        `chose "${suggestion.title}"${suggestion.series ? ` (series: ${suggestion.series})` : ''}`
      );
      report('suggestion', `Chose "${suggestion.title}"`);
    } catch (err) {
      await logStep(channelId, null, 'suggestion', 'error', String(err?.message || err));
      throw err;
    }

    // ---- Phase: video record ----
    videoId = createId();
    createdAt = Date.now();
    project = { titles: [suggestion.title], selectedTitle: 0, series: suggestion.series || null };

    try {
      await withPhaseNetworkResilience('video-record', channelId, videoId, logStep, persist);
      await logStep(channelId, videoId, 'video-record', 'success', 'created video record');
      report('video-record', 'Created video record');
      // Automation's equivalent of ChannelDashboardStep.jsx's "Start this video" — this suggestion
      // was the Content Program Manager's answer to a pending promise (see the suggestion phase's
      // pendingPromises above), so mark the ORIGINAL video that made that promise as fulfilled now
      // that a real video committing to it exists. Best-effort: never fails the cycle over this.
      if (suggestion.fulfills_promise_video_id) {
        loadVideo(suggestion.fulfills_promise_video_id)
          .then((v) => (v ? saveVideo({ ...v, promiseFulfilled: true }) : null))
          .catch((err) => console.error('[fullPipelineRecipe] failed to mark promise as fulfilled', err));
      }
    } catch (err) {
      await logStep(channelId, videoId, 'video-record', 'error', String(err?.message || err));
      throw err;
    }

    // ---- Phase: outline ----
    try {
      await withPhaseNetworkResilience('outline', channelId, videoId, logStep, async () => {
        const aiDecidesLength = channel.automation_ai_decides_length === true;
        const res = await fetch('/api/generate-outline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: suggestion.title,
            title: suggestion.title,
            angle: suggestion.angle || '',
            language: settings.language,
            lengthMinutes: settings.lengthMinutes,
            aiDecidesLength,
            // Only actually sent (and only meaningful server-side) when both AI-decides-length AND
            // the channel's own safety-cap toggle are on — disabling the cap means these are simply
            // never included, full freedom, exactly as AutomationStep.jsx's toggle promises.
            ...(aiDecidesLength && channel.automation_length_cap_enabled
              ? { capMinMinutes: channel.automation_length_cap_min, capMaxMinutes: channel.automation_length_cap_max }
              : {}),
            style: STYLES[settings.style].label,
            imageProvider: settings.imageProvider,
            characterHints: [],
            generalNotes: '',
            references: [],
            creativeOverride: channel.prompt_overrides?.outline || null,
            channelIntroEnabled: channel.automation_channel_intro === true,
            niche: channel.niche || '',
          }),
        });
        const outlineData = await res.json();
        if (!res.ok) throw new Error(outlineData.error || 'Outline generation failed');

        const characterBible = (outlineData.character_bible || []).map((c) => ({
          id: c.id || crypto.randomUUID(),
          name: c.name || '',
          baseDescription: c.base_description || '',
          variants: Array.isArray(c.variants) ? c.variants.map((v) => ({ label: v.label || '', description: v.description || '' })) : [],
        }));

        plan = {
          title: suggestion.title,
          angle: suggestion.angle || '',
          description: outlineData.description || '',
          tags: outlineData.tags || [],
          thumbnails: outlineData.thumbnail_concepts || [],
          characterBible,
          references: [],
          outline: outlineData.outline || [],
          totalScenes: outlineData.total_scenes || 0,
        };

        project = {
          titles: [plan.title],
          selectedTitle: 0,
          description: plan.description,
          tags: plan.tags,
          thumbnails: plan.thumbnails,
          subtitles: true,
          references: plan.references,
          characterBible: plan.characterBible,
          scenes: [],
          series: suggestion.series || null,
          // Persisted (not just kept on the in-memory `plan`) specifically so a resumed session can
          // reconstruct what the scenes phase needs to continue from — see determineResumePhase and
          // the resume-aware scenes phase below, which read these back via plan.outline/totalScenes.
          outline: plan.outline,
          totalScenes: plan.totalScenes,
        };

        await persist();
      });
      await logStep(channelId, videoId, 'outline', 'success', `${plan.outline.length} chapters, ${plan.totalScenes} scenes planned`);
      report('outline', 'Outline ready');
    } catch (err) {
      await logStep(channelId, videoId, 'outline', 'error', String(err?.message || err));
      throw err;
    }
  }

  if (shouldRunPhase(resumePhase, 'scenes')) {
    // ---- Phase: scenes ----
    try {
      await withPhaseNetworkResilience('scenes', channelId, videoId, logStep, async () => {
        const context = {
          topic: suggestion.title,
          title: plan.title,
          language: settings.language,
          style: STYLES[settings.style].label,
          format: settings.format,
          imageProvider: settings.imageProvider,
          characterBible: plan.characterBible,
          references: [],
          creativeOverride: channel.prompt_overrides?.scenes || null,
          channelIntroEnabled: channel.automation_channel_intro === true,
          niche: channel.niche || '',
        };

        // Resuming mid-scenes: whatever's already in project.scenes (from an earlier, interrupted
        // attempt) is kept as-is and only the REMAINING chapters/chunks are generated — see
        // sceneOrchestrator.js's resumeFrom param. previousTail seeds narrative continuity from the
        // last already-written scene, same as the continuity between chunks within one call.
        const existingScenes = resumePhase === 'scenes' ? project.scenes || [] : [];
        const resumeFrom = existingScenes.length
          ? { alreadyGeneratedCount: existingScenes.length, previousTail: existingScenes[existingScenes.length - 1]?.narration || null }
          : null;

        const { scenes: newRawScenes, promisedFollowUp } = await generateAllScenes(
          plan.outline,
          context,
          (soFarNew, total) => {
            const combined = [...existingScenes, ...buildScenesFromRaw(soFarNew)];
            report('scenes', `${combined.length}/${total} scenes written`);
            project = { ...project, scenes: combined };
            persist().catch((err) => console.error('[fullPipelineRecipe] partial scene save failed', err));
          },
          resumeFrom
        );

        project = {
          ...project,
          scenes: [...existingScenes, ...buildScenesFromRaw(newRawScenes)],
          promisedFollowUp: promisedFollowUp || project.promisedFollowUp || null,
        };
        await persist();
      });
      await logStep(channelId, videoId, 'scenes', 'success', `${project.scenes.length} scenes generated`);
    } catch (err) {
      await logStep(channelId, videoId, 'scenes', 'error', String(err?.message || err));
      throw err;
    }
  }

  // ---- Phase: media (images + audio) ----
  // Audio always goes through the existing synchronous path regardless of image provider — voice
  // generation has nothing to do with which image provider is configured. Images either go through
  // that same synchronous path (every provider except 'nanobanana-batch') or through Gemini Batch
  // (submit now, resolve on a later cycle — see below).
  const usesGeminiBatch = settings.imageProvider === 'nanobanana-batch';
  let mediaStillInProgress = false;

  if (shouldRunPhase(resumePhase, 'media')) {
  try {
    await withPhaseNetworkResilience('media', channelId, videoId, logStep, async () => {
      const mediaOnProgress = (evt) => {
        project = applyMediaProgress(project, evt);
        if (evt.kind === 'message' && evt.text) report('media', evt.text);
        // Per-item network retries from mediaGenerationEngine.js's own timeout+retry wrapper —
        // surfaced here as a 'retrying' log row rather than left as suspicious silence. Fired
        // before the item's own retry, so it never blocks or replaces the item's eventual
        // 'beat'/'scene' status update.
        if (evt.kind === 'retry') logStep(channelId, videoId, 'media', 'retrying', evt.message).catch(() => {});
        // Persist the instant a single beat/audio reaches a terminal state (ready or error) —
        // not just once at the end of the whole phase (see below). generateAllMedia never throws
        // for an individual item failure, so without this, a mid-phase failure (a provider rate
        // limit, say) would leave every already-succeeded item's Storage upload orphaned: the
        // file exists, but the video record is never updated to reference it, since the phase's
        // own persist() further down only runs once every item has succeeded. Fire-and-forget,
        // same pattern as the scenes phase above.
        const beatDone = evt.kind === 'beat' && (evt.patch?.status === 'ready' || evt.patch?.status === 'error');
        const audioDone = evt.kind === 'scene' && (evt.patch?.audioStatus === 'ready' || evt.patch?.audioStatus === 'error');
        if (beatDone || audioDone) persist().catch((err) => console.error('[fullPipelineRecipe] partial media save failed', err));
      };

      if (usesGeminiBatch) {
        // Voice only here — skipImages so generateAllMedia's own image half (irrelevant on this
        // path) never runs at all, let alone fights with the batch path below.
        await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: mediaOnProgress, skipImages: true });

        // Resume whatever this video already has outstanding first (a genuine cross-cycle resume,
        // or this very call picking back up after an earlier phase in the SAME call failed
        // partway — either way, resumePendingBatches is cheap/no-op when there's nothing pending).
        if ((project.pendingImageBatches || []).length > 0) {
          project = await resumePendingBatches(project, {
            userId,
            videoId,
            channelId,
            settings,
            onProgress: mediaOnProgress,
            persist: async (proj) => {
              project = proj;
              await persist();
            },
          });
        }

        const stillMissingImages = project.scenes.some((s) => s.images.some((im) => im.status !== 'ready'));
        if (stillMissingImages && (project.pendingImageBatches || []).length === 0) {
          // Nothing outstanding for this video yet at all — submit now. Chunks go out in
          // parallel (see geminiBatchImageEngine.js); each one's pendingEntry is persisted as
          // soon as it comes back, serialized here so concurrent submissions can't finish their
          // saveVideo calls out of order and silently drop an already-appended entry.
          let persistChain = Promise.resolve();
          await generateAllMediaViaBatch(project, {
            settings,
            channelId,
            videoId,
            logStep,
            resolution: '0.5K',
            onProgress: (evt) => {
              if (evt.kind === 'message' && evt.text) report('media', evt.text);
              if (evt.kind === 'batch-submitted') {
                project = { ...project, pendingImageBatches: [...(project.pendingImageBatches || []), evt.pendingEntry] };
                persistChain = persistChain.then(persist).catch((err) => console.error('[fullPipelineRecipe] pending batch save failed', err));
              }
            },
          });
          await persistChain;
        }

        // A billing failure (exhausted audio credit, or a batch chunk that 402'd on submit) is not
        // "still in progress" — waiting for Google batch jobs that were never submitted would just
        // stall the video indefinitely. Surface it as the failure it is.
        const creditMsg = findCreditExhaustedError(project);
        if (creditMsg) throw new Error(creditMsg);

        const nowAllReady = project.scenes.every((s) => s.audioStatus === 'ready' && s.images.every((im) => im.status === 'ready'));
        if (!nowAllReady) mediaStillInProgress = true;
      } else {
        await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: mediaOnProgress });
        const allReady = project.scenes.every((s) => s.audioStatus === 'ready' && s.images.every((im) => im.status === 'ready'));
        if (!allReady) throw new Error(findCreditExhaustedError(project) || 'Some scenes failed to generate media (image or audio)');
      }

      await persist();
    });

    if (mediaStillInProgress) {
      const readyCount = project.scenes.reduce((n, s) => n + s.images.filter((im) => im.status === 'ready').length, 0);
      const totalCount = project.scenes.reduce((n, s) => n + s.images.length, 0);
      await logStep(channelId, videoId, 'media', 'pending', `${readyCount}/${totalCount} images ready — batch jobs still in progress`);
      report('media', `${readyCount}/${totalCount} images ready — batch jobs in progress`);
    } else {
      await logStep(channelId, videoId, 'media', 'success', 'all images and audio generated');
      report('media', 'Media complete');
    }
  } catch (err) {
    // A billing failure (fal.ai or Gemini Batch) is logged as its own 'credit_exhausted' status,
    // visually distinct from a generic 'error' in the automation history — see AutomationStep's
    // statusColor. The 💳 message came either straight from the thrown error or from a per-item
    // failure the throw above didn't itself carry.
    const creditMsg = isCreditExhaustedMessage(err?.message) ? err.message : findCreditExhaustedError(project);
    if (creditMsg) {
      await logStep(channelId, videoId, 'media', 'credit_exhausted', creditMsg);
    } else {
      await logStep(channelId, videoId, 'media', 'error', String(err?.message || err));
    }
    throw err;
  }
  }

  if (mediaStillInProgress) {
    // Not a failure — this video will be picked up again by the resume check on a later cycle.
    // automationEngine.js treats inProgress specially: no upload-count increment (nothing was
    // actually produced yet) and no exhaustion-loop retry on this same channel this cycle.
    return { videoId, youtubeVideoId: null, costUsd: await totalCostForVideo(channelId, videoId), inProgress: true };
  }

  // ---- Phase: render ----
  // videoBlob defaults to whatever rehydrateProjectMedia already restored from
  // renderedVideoStoragePath (see the resume check above) — only actually re-rendered when
  // shouldRunPhase says this phase hasn't happened yet.
  let videoBlob = project.renderedVideoBlob || null;
  if (shouldRunPhase(resumePhase, 'render')) {
  try {
    await withPhaseNetworkResilience('render', channelId, videoId, logStep, async () => {
      videoBlob = await renderVideoForExport(project, settings, {
        onProgress: (frameIndex, totalFrames) => report('render', `${Math.round((frameIndex / totalFrames) * 100)}%`),
      });
      // Backed up to Storage (same pattern as the thumbnail phase below) — a video the automation
      // publishes right after this in the same call never needs to read it back, but a resumed
      // session interrupted anywhere after this point (thumbnail, YouTube) can skip re-rendering
      // entirely instead of redoing this potentially slow, CPU-heavy phase from scratch.
      const renderedVideoStoragePath = await uploadMedia(userId, videoId, 'rendered-video', 'video', videoBlob);
      project = { ...project, renderedVideoBlob: videoBlob, renderedVideoStoragePath };
      await persist();
    });
    await logStep(channelId, videoId, 'render', 'success', 'MP4 rendered');
    report('render', 'Render complete');
  } catch (err) {
    // No DOM-mounted <canvas> exists in the automation context, so WebCodecsUnsupportedError (the
    // manual UI's trigger for its WebM/MediaRecorder fallback) is a hard failure here rather than a
    // fallback opportunity — a known Phase 2a limitation, not an oversight.
    await logStep(channelId, videoId, 'render', 'error', String(err?.message || err));
    throw err;
  }
  }

  // ---- Phase: thumbnail ----
  let thumbnailBlob;
  if (shouldRunPhase(resumePhase, 'thumbnail')) {
  try {
    await withPhaseNetworkResilience('thumbnail', channelId, videoId, logStep, async () => {
      const concept = plan.thumbnails[0];
      if (!concept) throw new Error('No thumbnail concept available from the outline');
      thumbnailBlob = await generateThumbnail(project, {
        settings,
        channelId,
        userId,
        videoId,
        thumbIdx: 0,
        overlayText: concept.overlay_text || '',
        seed: Math.floor(Math.random() * 999999),
      });
      const thumbnailStoragePath = await uploadMedia(userId, videoId, 'thumbnail', 'thumbnail', thumbnailBlob);
      project = { ...project, thumbnailStoragePath };
      await persist();
    });
    await logStep(channelId, videoId, 'thumbnail', 'success', 'thumbnail created');
    report('thumbnail', 'Thumbnail ready');
  } catch (err) {
    // The thumbnail is a paid fal.ai image too (nanobanana/gptimage) — an exhausted balance here
    // gets the same distinct 'credit_exhausted' status as the media phase.
    const status = isCreditExhaustedMessage(err?.message) ? 'credit_exhausted' : 'error';
    await logStep(channelId, videoId, 'thumbnail', status, String(err?.message || err));
    throw err;
  }
  } else {
    // Already done on an earlier attempt — read the backed-up thumbnail back rather than
    // regenerating it, since it's about to be needed for the YouTube phase below.
    try {
      thumbnailBlob = await downloadMediaAsBlob(project.thumbnailStoragePath);
    } catch (err) {
      console.error('[fullPipelineRecipe] could not restore thumbnail from storage on resume', project.thumbnailStoragePath, err);
      throw err;
    }
  }

  // ---- Phase: YouTube ----
  // Deliberately NOT wrapped in withPhaseNetworkResilience, unlike every other phase: a network
  // error here can happen AFTER the upload already reached YouTube (the request succeeded
  // server-side but the response was lost to the same drop) — retrying the whole phase risks
  // publishing the same video twice. A duplicate public upload is a worse outcome than a failed
  // cycle, so this phase fails immediately on any error (network or not) and asks for a manual
  // check instead of an automatic retry.
  let youtubeVideoId = null;
  // Auto-publish is gated so it NEVER re-fires for a video whose earlier attempt might already have
  // reached YouTube. wasResumed alone is too blunt (see the resume check above): it's true for the
  // normal Gemini Batch "submit → wait → resume" flow, which must publish, and for a safe ready-to-
  // publish resume. Only a genuine anomalous mid-generation interruption — resumed, but NOT because
  // it was waiting on a batch job, and NOT already fully produced with the upload never started —
  // blocks here. The youtubeUploadStarted marker persisted just before publishToYoutube below is
  // what keeps a video that actually died mid-upload out of both this branch and findResumableVideo
  // on the next cycle (determineResumePhase returns null for it).
  const anomalousInterruption = wasResumed && !resumedFromNormalBatchWait && !resumedReadyToPublish;
  if (channel.automation_auto_publish === false) {
    // Auto-publish is off for this channel — the video is already fully produced (render +
    // thumbnail are done and persisted above), it just never goes near YouTube's API. Leaves it
    // exactly where a manually-created video would sit: reviewable and independently publishable
    // by hand from Storyboard/Editor/Export. automation_daily_upload_count still increments in
    // automationEngine.js after this returns — it counts videos *produced*, not videos published.
    await logStep(channelId, videoId, 'youtube', 'success', 'video ready for manual review — auto-publish disabled');
    report('youtube', 'Auto-publish disabled — ready for manual review');
  } else if (anomalousInterruption) {
    const message = 'video ready for manual review — resumed after an anomalous interruption mid-generation, publish is not auto-retried to avoid a possible duplicate upload';
    await logStep(channelId, videoId, 'youtube', 'success', message);
    report('youtube', 'Resumed video — ready for manual review, not auto-published');
  } else {
    try {
      // Persist that a publish is being ATTEMPTED before any bytes go out. If this call then dies
      // mid-upload (a network drop after the request reached YouTube but before its response),
      // determineResumePhase sees youtubeUploadStarted on the next cycle and returns null — the
      // video is left for manual review instead of risking a duplicate. Set once; a successful
      // publish supersedes it with youtubeVideoId.
      if (!project.youtubeUploadStarted) {
        project = { ...project, youtubeUploadStarted: true };
        await persist();
      }

      const metadata = {
        title: plan.title,
        description: plan.description,
        tags: plan.tags,
        categoryId: channel.automation_youtube_category || DEFAULT_YOUTUBE_CATEGORY_ID,
        language: YOUTUBE_LANGUAGE_CODES[settings.language] || 'en',
        privacyStatus: 'public',
        scheduleMode: 'now',
        publishAt: null,
        madeForKids: channel.automation_made_for_kids === true,
        uploadCaptions: true,
        addToPlaylist: !!suggestion.series,
      };

      // publishToYoutube never throws for a degraded (but non-fatal) thumbnail/captions/playlist
      // phase — same as the manual UI, where each of those stays independently retryable and
      // doesn't block the upload that already succeeded. Collected here only to attach a warning
      // to the 'success' log message, not to fail the phase outright.
      const subErrors = [];
      youtubeVideoId = await publishToYoutube(project, videoBlob, thumbnailBlob, {
        channel,
        metadata,
        onProgress: (evt) => {
          if (evt.kind === 'error') subErrors.push(`${evt.phase}: ${evt.message}`);
          if (evt.kind === 'upload-progress') report('youtube', `Uploading… ${evt.percent}%`);
        },
      });

      if (!youtubeVideoId) throw new Error(subErrors.find((m) => m.startsWith('upload:')) || 'YouTube upload failed');

      // Persisted so a later Storyboard/Editor/Export session (or a resumed browser tab) knows
      // this video is already live — without this, ExportStep.jsx would have no way to tell and
      // could re-upload the same video as a duplicate.
      project = { ...project, youtubeVideoId };
      await persist();

      const message = subErrors.length ? `published (${youtubeVideoId}) with issues: ${subErrors.join('; ')}` : `published (${youtubeVideoId})`;
      await logStep(channelId, videoId, 'youtube', 'success', message);
      report('youtube', 'Published to YouTube');
    } catch (err) {
      if (isNetworkError(err)) {
        const message =
          'YouTube publish failed due to a network error — check YouTube Studio manually before retrying, to avoid a duplicate upload.';
        await logStep(channelId, videoId, 'youtube', 'error', message);
        throw new Error(message);
      }
      await logStep(channelId, videoId, 'youtube', 'error', String(err?.message || err));
      throw err;
    }
  }

  // Total real spend for this video, from the cost-ledger entries recordCost wrote along the way
  // (inside mediaGenerationEngine.js/thumbnailEngine.js/batchResumption.js) — not tracked
  // incrementally here since those writes happen deep inside modules this recipe doesn't
  // otherwise need to instrument.
  const costUsd = await totalCostForVideo(channelId, videoId);

  return { videoId, youtubeVideoId, costUsd };
}
