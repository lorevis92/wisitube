// Static-background recipe for the automation engine — content_type 'static_background' (spoken
// narration over one unchanging background, no per-scene images). Same overall shape as
// fullPipelineRecipe.js (suggestion → video record → outline → scenes → media → render →
// thumbnail → YouTube), composing the same existing engine modules, but with the per-scene image
// phases removed entirely and a single background-setup phase in their place.
//
// A video interrupted partway (browser tab closed, computer slept, any crash) is picked back up
// from wherever it actually left off — suggestion/outline, scenes, media, render, or thumbnail —
// via findResumableVideo + determineResumePhase (see src/lib/videoResumption.js, shared with
// fullPipelineRecipe.js), NOT restarted from scratch. YouTube publish auto-resumes only when it's
// provably a safe first attempt (see the 'youtube' phase below); a genuine anomalous interruption
// mid-generation still stops for manual review, and a video stuck failing the same phase
// MAX_RESUME_ATTEMPTS times in a row is marked permanently stuck rather than retried forever.
//
// Every phase logs exactly once via the injected logStep(channelId, videoId, step, status,
// message) — 'success' on completion, 'error' right before re-throwing — and a failure in any
// phase stops the whole recipe immediately: later phases never run against an incomplete video.
import { createId, saveVideo, loadVideo, listVideosByChannel, getCostsByChannel } from '../db';
import { uploadMedia, downloadMediaAsBlob } from '../mediaStorage';
import { generateAllScenes } from '../sceneOrchestrator';
import { generateAllMedia } from '../mediaGenerationEngine';
import { rehydrateProjectMedia } from '../mediaRehydration';
import { renderVideoForExport } from '../videoRenderEngine';
import { generateThumbnail } from '../thumbnailEngine';
import { publishToYoutube } from '../youtubePublishEngine';
import { buildSrtFromScenes } from '../srtBuilder';
import { runLocalExport, exportDateString, localExportPreflight } from '../localExport';
import { withTimeout } from '../asyncTimeout';

// Hang guards for render/thumbnail — see fullPipelineRecipe.js's identical constants.
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const THUMBNAIL_RESTORE_TIMEOUT_MS = 3 * 60 * 1000;
import { getTopicSuggestions, startTopicSuggestion } from '../contentProgramManager';
import { determineResumePhase, trackResumeAttempt, shouldRunPhase, RESUME_PHASE_PUBLISH, RESUMABLE_VIDEO_WINDOW_MS, MAX_RESUME_ATTEMPTS } from '../videoResumption';
import { STYLES } from '../pollinations';
import { MINIMAX_VOICES } from '../voiceProviders';

async function totalCostForVideo(channelId, videoId) {
  const { items: costItems } = await getCostsByChannel(channelId);
  return costItems.filter((c) => c.videoId === videoId).reduce((sum, c) => sum + (c.amountUsd || 0), 0);
}

// Same as fullPipelineRecipe.js's own findResumableVideo — see there for the full reasoning.
// Duplicated rather than shared, same controlled-duplication convention already used between these
// two recipe files for isNetworkError/waitForOnline/etc.
async function findResumableVideo(channelId) {
  const videos = await listVideosByChannel(channelId);
  const cutoff = Date.now() - RESUMABLE_VIDEO_WINDOW_MS;
  return (
    videos.find((v) => {
      if ((v.createdAt || 0) < cutoff) return false;
      if (v.youtubeVideoId) return false;
      if (v.stuckError) return false;
      // Automatic cycles only ever resume automation's own videos — see fullPipelineRecipe.js's
      // identical guard for the reasoning (createdByAutomation flag, with a persisted-outline
      // fallback for pre-flag videos; the manual flow never persists an outline).
      if (v.createdByAutomation !== true && !(Array.isArray(v.outline) && v.outline.length > 0)) return false;
      // RESUME_PHASE_PUBLISH (render + thumbnail done, only the YouTube upload left) is deliberately
      // excluded — an automatic cycle never auto-publishes a resumed video (see the revert of 13a1dbd
      // and fullPipelineRecipe.js's identical findResumableVideo).
      const phase = determineResumePhase(v, v.outline);
      return phase !== null && phase !== RESUME_PHASE_PUBLISH;
    }) || null
  );
}

const NETWORK_WAIT_POLL_MS = 30000;
const NETWORK_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Same detection heuristic as fullPipelineRecipe.js's own copy — duplicated rather than shared,
// same controlled-duplication convention already used between these two recipe files.
function isNetworkError(err) {
  if (err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '');
  return /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK/i.test(msg);
}

async function waitForOnline() {
  const deadline = Date.now() + NETWORK_WAIT_TIMEOUT_MS;
  while (!navigator.onLine) {
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, NETWORK_WAIT_POLL_MS));
  }
  return true;
}

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

// Same transform App.jsx's buildScenesFromRaw performs, but always in "no image_beats" mode — this
// recipe only ever runs for content_type 'static_background' (see automationEngine.js's
// getRecipeForContentType), so there's no fixed-vs-static-background branch to carry here at all.
//
// sceneIdBase: the first id to hand out, assigned deterministically (base + position) rather than
// from a mutating module counter — see fullPipelineRecipe.js's copy for the full reasoning (a
// module counter resets on page reload, so a resume of a partly-generated video would restart at 1
// and collide with already-persisted scene ids). The scenes phase computes this from the max id
// already on the video.
function buildScenesFromRaw(rawScenes, sceneIdBase = 1) {
  return (rawScenes || []).map((s, i) => ({
    id: sceneIdBase + i,
    narration: s.narration || '',
    pad: 0.3,
    audioStatus: 'idle',
    audioUrl: '',
    audioBlob: null,
    audioDuration: 0,
  }));
}

// Applies a mediaGenerationEngine.js onProgress event (audio only in this recipe — see the media
// phase below) to a local project copy, same reasoning as fullPipelineRecipe.js's own version:
// there's no React state to read back from in a headless caller.
function applyMediaProgress(project, evt) {
  if (evt.kind !== 'scene') return project;
  const sceneId = Number(evt.sceneId);
  return { ...project, scenes: project.scenes.map((s) => (s.id === sceneId ? { ...s, ...evt.patch } : s)) };
}

const DEFAULT_STYLE = 'facestick';
const DEFAULT_LANGUAGE = 'English';
const DEFAULT_FORMAT = '16:9';
const DEFAULT_KOKORO_VOICE = 'af_heart';
const DEFAULT_YOUTUBE_CATEGORY_ID = '27'; // Education

// Same mapping as ExportStep.jsx/fullPipelineRecipe.js's own local constant — duplicated for the
// same controlled-duplication reason.
const YOUTUBE_LANGUAGE_CODES = { English: 'en', Italiano: 'it', Español: 'es', Français: 'fr', Deutsch: 'de' };

function buildAutomationSettings(channel) {
  const voiceEngine = channel.automation_voice_engine || 'kokoro';
  const voice = channel.automation_voice || (voiceEngine === 'minimax' ? MINIMAX_VOICES[0].id : DEFAULT_KOKORO_VOICE);
  return {
    style: channel.automation_style || DEFAULT_STYLE,
    language: channel.automation_language || DEFAULT_LANGUAGE,
    format: channel.automation_format || DEFAULT_FORMAT,
    // Still relevant here even though there's no per-scene image generation — the thumbnail phase
    // below uses it exactly like fullPipelineRecipe.js does.
    imageProvider: channel.automation_image_provider || 'pollinations',
    contentType: 'static_background',
    voiceEngine,
    voice,
    speechSpeed: Number(channel.automation_speech_speed) || 1.0,
    lengthMinutes: Number(channel.automation_length_minutes) || 5,
  };
}

// Builds this video's background/text-style config directly from the channel's own defaults
// (ChannelDashboardStep.jsx) — automation never generates a fresh per-video background image, it
// reuses whichever default (image or color) the channel owner already configured, same
// imageStoragePath reused as-is (uploadMedia/downloadMediaAsBlob only care about the path string,
// not who originally uploaded it — see ChannelDashboardStep.jsx's channelDefaultsPseudoVideoId).
// There is no per-video override in automation (unlike the manual Storyboard flow) — a channel
// owner who wants a specific video to differ can still open it manually afterward and change it there.
function buildStaticBackgroundFromChannel(channel) {
  const hasImage = !!channel.automation_static_bg_image_path;
  return {
    staticBackground: {
      type: hasImage ? 'image' : 'color',
      color: channel.automation_static_bg_color || '#111111',
      imageStoragePath: hasImage ? channel.automation_static_bg_image_path : null,
      url: null,
      blob: null,
    },
    staticTextStyle: {
      textColor: channel.automation_static_text_color || '#FFFFFF',
      outline: channel.automation_static_text_outline !== false,
      outlineColor: channel.automation_static_text_outline_color || '#000000',
    },
  };
}

/**
 * channel/userId/onProgress/logStep: same contract as fullPipelineRecipe.js's runFullPipeline.
 * Returns { videoId, youtubeVideoId, costUsd } — no `inProgress` case (unlike fullPipelineRecipe.js's
 * Gemini Batch handling, every phase here is fully synchronous within one call, so a call to this
 * function either finishes the video or throws — it never returns "still working, check back
 * later"). youtubeVideoId is null when auto-publish is off, and when the video was resumed after an
 * anomalous mid-generation interruption (a safe ready-to-publish resume still publishes — see the
 * YouTube phase below). Throws (after marking project.stuckError) when a resumed video has failed
 * the same phase MAX_RESUME_ATTEMPTS times in a row.
 *
 * targetVideoId: optional — see fullPipelineRecipe.js's identical param for the full reasoning
 * (AutomationMirrorStep.jsx's "Resume now" button, bypasses findResumableVideo's channel-wide
 * search and the 7-day window, never touches the scheduler lock).
 */
// manualPublish: see fullPipelineRecipe.js — set only by the dashboard's "Publish now" button, an
// explicit per-video click; it forces the YouTube upload past the auto-publish toggle and the
// anomalous-interruption hold. Never set by any automatic path.
export async function runStaticBackgroundPipeline(channel, { userId, onProgress, logStep, targetVideoId, manualPublish = false } = {}) {
  const channelId = channel.id;
  const settings = buildAutomationSettings(channel);
  let videoId = null;
  let project = null;
  let plan = null;
  let suggestion = null;
  let createdAt = Date.now();
  const report = (step, message) => onProgress?.({ step, message, videoId, project });

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
  // See fullPipelineRecipe.js's identical block for the full reasoning — duplicated rather than
  // shared, same controlled-duplication convention already used between these two files.
  const resumable = targetVideoId ? await loadVideo(targetVideoId) : await findResumableVideo(channelId);
  let resumePhase = 'suggestion';
  const wasResumed = !!resumable;
  // See fullPipelineRecipe.js's identical block for the full reasoning. resumedFromNormalBatchWait
  // never fires for this content type (no Gemini Batch — everything is synchronous), but it's kept
  // for structural parity; resumedReadyToPublish still matters (a static_background video fully
  // produced but left unpublished must be able to auto-publish on a later cycle).
  let resumedFromNormalBatchWait = false;
  let resumedReadyToPublish = false;

  if (resumable) {
    videoId = resumable.id;
    createdAt = resumable.createdAt || Date.now();
    project = await rehydrateProjectMedia(resumable);
    // See fullPipelineRecipe.js's identical line — stamp createdByAutomation on a findResumableVideo
    // pickup (never on an explicit targetVideoId resume).
    if (!targetVideoId && project.createdByAutomation !== true) {
      project = { ...project, createdByAutomation: true };
    }
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

    if ((resumePhase === 'thumbnail' || resumePhase === RESUME_PHASE_PUBLISH || resumePhase === null) && !project.renderedVideoBlob) resumePhase = 'render';

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

  // See fullPipelineRecipe.js: don't generate a brand-new video for a local_folder channel that
  // has no usable export folder set up — logged as a visible 'error', not a muted 'skipped'.
  if (!wasResumed && channel.automation_export_mode === 'local_folder') {
    const pre = await localExportPreflight();
    if (!pre.ok) {
      const message = `Local folder export can't run: ${pre.reason}. Open Automation settings for this channel and click "Choose export folder", then run the cycle again.`;
      await logStep(channelId, null, 'youtube', 'error', message);
      report('youtube', 'Local folder export not set up — see Automation settings');
      return { videoId: null, youtubeVideoId: null, costUsd: 0, skipped: true, reasonLogged: true, reason: message };
    }
  }

  if (shouldRunPhase(resumePhase, 'suggestion')) {
  // ---- Phase: suggestion ----
  try {
    suggestion = await withPhaseNetworkResilience('suggestion', channelId, null, logStep, async () => {
      const existingVideos = await listVideosByChannel(channelId);
      // Same cached, scored suggestion pool ChannelDashboardStep.jsx's panel reads from (see
      // src/lib/contentProgramManager.js) — within the 24h cache window this is a free read, no new
      // Claude/Trends/YouTube calls at all.
      const { channel: scoredChannel, finalSuggestions } = await getTopicSuggestions(channel, { videos: existingVideos });
      if (!finalSuggestions.length) throw new Error('Content Program Manager returned no suggestions');
      const picked = finalSuggestions.find((s) => s.priority === 'high') || finalSuggestions[0];
      // Same mechanism as ChannelDashboardStep.jsx's "Start this video" — removes `picked` from the
      // shared cached list and backfills it, so the dashboard stops showing an idea this automation
      // cycle just committed to as a real video.
      await startTopicSuggestion(scoredChannel, picked, existingVideos);
      return picked;
    });
    await logStep(channelId, null, 'suggestion', 'success', `chose "${suggestion.title}"${suggestion.series ? ` (series: ${suggestion.series})` : ''}`);
    report('suggestion', `Chose "${suggestion.title}"`);
  } catch (err) {
    await logStep(channelId, null, 'suggestion', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: video record ----
  videoId = createId();
  // createdByAutomation marks this as a record an automatic cycle may resume later (findResumableVideo).
  // subject: the Content Program Manager's bare proper-name — comparison-only, feeds anti-repetition.
  project = {
    titles: [suggestion.title],
    selectedTitle: 0,
    series: suggestion.series || null,
    createdByAutomation: true,
    subject: suggestion.subject || null,
  };

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
        .catch((err) => console.error('[staticBackgroundRecipe] failed to mark promise as fulfilled', err));
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
          contentType: 'static_background',
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

      const { staticBackground, staticTextStyle } = buildStaticBackgroundFromChannel(channel);

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
        staticBackground,
        staticTextStyle,
        // Re-set here because this phase replaces project wholesale.
        createdByAutomation: true,
        subject: suggestion.subject || null, // comparison-only — see the video-record phase
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
        contentType: 'static_background',
        characterBible: plan.characterBible,
        references: [],
        creativeOverride: channel.prompt_overrides?.scenes || null,
        channelIntroEnabled: channel.automation_channel_intro === true,
        niche: channel.niche || '',
      };

      // Resuming mid-scenes: whatever's already in project.scenes (from an earlier, interrupted
      // attempt) is kept as-is and only the REMAINING chapters/chunks are generated — see
      // sceneOrchestrator.js's resumeFrom param.
      const existingScenes = resumePhase === 'scenes' ? project.scenes || [] : [];
      const resumeFrom = existingScenes.length
        ? { alreadyGeneratedCount: existingScenes.length, previousTail: existingScenes[existingScenes.length - 1]?.narration || null }
        : null;

      // Start new scene ids strictly above every id already on this video (0 for a brand-new one →
      // base 1), so a resume — possibly in a later browser session — never reuses an id from a
      // partially-generated earlier run. See buildScenesFromRaw's own note.
      const sceneIdBase = existingScenes.reduce((m, s) => Math.max(m, Number(s?.id) || 0), 0) + 1;

      const { scenes: newRawScenes, promisedFollowUp } = await generateAllScenes(
        plan.outline,
        context,
        (soFarNew, total) => {
          const combined = [...existingScenes, ...buildScenesFromRaw(soFarNew, sceneIdBase)];
          report('scenes', `${combined.length}/${total} scenes written`);
          project = { ...project, scenes: combined };
          persist().catch((err) => console.error('[staticBackgroundRecipe] partial scene save failed', err));
        },
        resumeFrom
      );

      project = {
        ...project,
        scenes: [...existingScenes, ...buildScenesFromRaw(newRawScenes, sceneIdBase)],
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

  // ---- Phase: media (voice only — no per-scene images for this content type) ----
  if (shouldRunPhase(resumePhase, 'media')) {
  try {
    await withPhaseNetworkResilience('media', channelId, videoId, logStep, async () => {
      const mediaOnProgress = (evt) => {
        project = applyMediaProgress(project, evt);
        if (evt.kind === 'message' && evt.text) report('media', evt.text);
        if (evt.kind === 'retry') logStep(channelId, videoId, 'media', 'retrying', evt.message).catch(() => {});
        const audioDone = evt.kind === 'scene' && (evt.patch?.audioStatus === 'ready' || evt.patch?.audioStatus === 'error');
        if (audioDone) persist().catch((err) => console.error('[staticBackgroundRecipe] partial media save failed', err));
      };

      await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: mediaOnProgress, skipImages: true });
      const allReady = project.scenes.every((s) => s.audioStatus === 'ready');
      if (!allReady) throw new Error('Some scenes failed to generate voiceover');

      await persist();
    });
    await logStep(channelId, videoId, 'media', 'success', 'voiceover generated');
    report('media', 'Voiceover complete');
  } catch (err) {
    await logStep(channelId, videoId, 'media', 'error', String(err?.message || err));
    throw err;
  }
  }

  // ---- Phase: render ----
  // The rendered MP4 is never persisted — only images, audio and the thumbnail are. On a resume
  // project.renderedVideoBlob is always null so this phase always runs, re-rendering from the
  // persisted materials. See fullPipelineRecipe.js's identical phase.
  let videoBlob = project.renderedVideoBlob || null;
  if (shouldRunPhase(resumePhase, 'render')) {
  try {
    await withPhaseNetworkResilience('render', channelId, videoId, logStep, async () => {
      videoBlob = await withTimeout(
        () =>
          renderVideoForExport(project, settings, {
            onProgress: (frameIndex, totalFrames) => report('render', `${Math.round((frameIndex / totalFrames) * 100)}%`),
          }),
        RENDER_TIMEOUT_MS,
        'Video render'
      );
      // Kept in-memory on `project` only for the thumbnail/publish phases in this same call
      // (stripped on every save — stripBlobsForSync). Never backed up to Storage.
      project = { ...project, renderedVideoBlob: videoBlob };
      await persist();
    });
    await logStep(channelId, videoId, 'render', 'success', 'MP4 rendered');
    report('render', 'Render complete');
  } catch (err) {
    // No DOM-mounted <canvas> exists in the automation context, so WebCodecsUnsupportedError (the
    // manual UI's trigger for its WebM/MediaRecorder fallback) is a hard failure here rather than a
    // fallback opportunity — same known Phase 2a limitation as fullPipelineRecipe.js.
    await logStep(channelId, videoId, 'render', 'error', String(err?.message || err));
    throw err;
  }
  }

  // ---- Phase: thumbnail ----
  // A YouTube listing thumbnail is a distinct thing from the in-video static background — every
  // video needs one for the video's own listing regardless of content_type, so this phase is
  // identical to fullPipelineRecipe.js's (thumbnailEngine.js never looks at project.scenes[].images
  // at all — it works from project.thumbnails[thumbIdx], the outline's own thumbnail concepts).
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
      const thumbnailStoragePath = await withTimeout(
        () => uploadMedia(userId, videoId, 'thumbnail', 'thumbnail', thumbnailBlob),
        THUMBNAIL_UPLOAD_TIMEOUT_MS,
        'Thumbnail upload to Storage'
      );
      project = { ...project, thumbnailStoragePath };
      await persist();
    });
    await logStep(channelId, videoId, 'thumbnail', 'success', 'thumbnail created');
    report('thumbnail', 'Thumbnail ready');
  } catch (err) {
    await logStep(channelId, videoId, 'thumbnail', 'error', String(err?.message || err));
    throw err;
  }
  } else {
    // Already done on an earlier attempt — read the backed-up thumbnail back rather than
    // regenerating it, since it's about to be needed for the YouTube phase below.
    try {
      thumbnailBlob = await withTimeout(
        () => downloadMediaAsBlob(project.thumbnailStoragePath),
        THUMBNAIL_RESTORE_TIMEOUT_MS,
        'Thumbnail restore from Storage'
      );
    } catch (err) {
      console.error('[staticBackgroundRecipe] could not restore thumbnail from storage on resume', project.thumbnailStoragePath, err);
      await logStep(channelId, videoId, 'thumbnail', 'error', `could not restore the saved thumbnail: ${String(err?.message || err)}`);
      throw err;
    }
  }

  // ---- Phase: publish (local folder export) ----
  // See fullPipelineRecipe.js's identical branch: 'local_folder' mode writes the finished files to
  // the user's chosen folder and leaves the video "not published" for a manual upload + "Mark as
  // published". A manual "Publish now" click skips this and goes straight to YouTube.
  if (!manualPublish && channel.automation_export_mode === 'local_folder') {
    try {
      const srt = buildSrtFromScenes(project.scenes, true);
      const folder = await runLocalExport({
        channelName: channel.name,
        dateStr: exportDateString(createdAt),
        title: plan.title,
        videoBlob,
        thumbnailBlob,
        srtContent: srt,
        publishInfo: {
          title: plan.title,
          description: plan.description,
          tags: plan.tags,
          categoryId: channel.automation_youtube_category || DEFAULT_YOUTUBE_CATEGORY_ID,
          language: settings.language || 'English',
          privacyStatus: 'public',
          publishAt: null,
          seriesName: suggestion.series || null,
          madeForKids: channel.automation_made_for_kids === true,
        },
      });
      project = { ...project, localExportedAt: Date.now() };
      await persist();
      await logStep(
        channelId,
        videoId,
        'youtube',
        'success',
        `exported to local folder "${folder}" — upload it to YouTube manually, then use "Mark as published"`
      );
      report('youtube', `Exported to ${folder}`);
      return { videoId, youtubeVideoId: null, costUsd: await totalCostForVideo(channelId, videoId) };
    } catch (err) {
      await logStep(channelId, videoId, 'youtube', 'error', `local folder export failed: ${String(err?.message || err)}`);
      throw err;
    }
  }

  // ---- Phase: YouTube ----
  // Deliberately NOT wrapped in withPhaseNetworkResilience — same duplicate-upload risk reasoning
  // as fullPipelineRecipe.js's identical phase.
  let youtubeVideoId = null;
  // See fullPipelineRecipe.js's identical YouTube-phase comment for the full reasoning — only a
  // genuine anomalous mid-generation interruption blocks auto-publish; a video that was simply
  // resumed and finished (or is a safe ready-to-publish resume) still publishes.
  const anomalousInterruption = wasResumed && !resumedFromNormalBatchWait && !resumedReadyToPublish;
  if (!manualPublish && channel.automation_auto_publish === false) {
    await logStep(channelId, videoId, 'youtube', 'success', 'video ready for manual review — auto-publish disabled');
    report('youtube', 'Auto-publish disabled — ready for manual review');
  } else if (!manualPublish && anomalousInterruption) {
    const message = 'video ready for manual review — resumed after an anomalous interruption mid-generation, publish is not auto-retried to avoid a possible duplicate upload';
    await logStep(channelId, videoId, 'youtube', 'success', message);
    report('youtube', 'Resumed video — ready for manual review, not auto-published');
  } else {
    try {
      // youtubeUploadStarted is persisted by onUploadStart below — fired by uploadVideo the instant
      // before the first byte PUT, never before. A pre-flight failure (bad videoBlob, dead
      // init-upload, no token) leaves the video cleanly re-publishable. See fullPipelineRecipe.js.
      const markUploadStarted = async () => {
        if (!project.youtubeUploadStarted) {
          project = { ...project, youtubeUploadStarted: true };
          await persist();
        }
      };

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

      const subErrors = [];
      youtubeVideoId = await publishToYoutube(project, videoBlob, thumbnailBlob, {
        channel,
        metadata,
        onUploadStart: markUploadStarted,
        onProgress: (evt) => {
          if (evt.kind === 'error') subErrors.push(`${evt.phase}: ${evt.message}`);
          if (evt.kind === 'upload-progress') report('youtube', `Uploading… ${evt.percent}%`);
        },
      });

      if (!youtubeVideoId) throw new Error(subErrors.find((m) => m.startsWith('upload:')) || 'YouTube upload failed');

      // youtubePublishedAt drives the storage cleanup window (src/lib/mediaArchival.js).
      // thumbnailPublishFailed / 'published_with_issues' — see fullPipelineRecipe.js's identical
      // handling: a video that went live without its custom thumbnail is not a clean green success.
      const thumbnailPublishFailed = subErrors.some((m) => m.startsWith('thumbnail:'));
      project = {
        ...project,
        youtubeVideoId,
        youtubePublishedAt: project.youtubePublishedAt || Date.now(),
        thumbnailPublishFailed,
      };
      await persist();

      if (subErrors.length) {
        await logStep(
          channelId,
          videoId,
          'youtube',
          'published_with_issues',
          `published (${youtubeVideoId}) but ${subErrors.length} finishing step(s) failed: ${subErrors.join('; ')}`
        );
        report('youtube', `Published — but ${subErrors.map((m) => m.split(':')[0]).join(', ')} failed`);
      } else {
        await logStep(channelId, videoId, 'youtube', 'success', `published (${youtubeVideoId})`);
        report('youtube', 'Published to YouTube');
      }
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

  const costUsd = await totalCostForVideo(channelId, videoId);
  return { videoId, youtubeVideoId, costUsd };
}
