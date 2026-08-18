// Static-background recipe for the automation engine — content_type 'static_background' (spoken
// narration over one unchanging background, no per-scene images). Same overall shape as
// fullPipelineRecipe.js (suggestion → video record → outline → scenes → media → render →
// thumbnail → YouTube), composing the same existing engine modules, but with the per-scene image
// phases removed entirely and a single background-setup phase in their place. No resume-across-
// sessions mechanism like fullPipelineRecipe.js's Gemini-Batch-specific one: every phase here is
// fully synchronous within one call (audio, one background image, render), so there's no async gap
// spanning browser sessions to resume across — a mid-run failure still leaves a resumable, reviewable
// video record behind (same persist-every-checkpoint principle), just not a "pick this exact video
// back up automatically" mechanism.
//
// Every phase logs exactly once via the injected logStep(channelId, videoId, step, status,
// message) — 'success' on completion, 'error' right before re-throwing — and a failure in any
// phase stops the whole recipe immediately: later phases never run against an incomplete video.
import { createId, saveVideo, loadVideo, listVideosByChannel, getCostsByChannel } from '../db';
import { uploadMedia } from '../mediaStorage';
import { generateAllScenes } from '../sceneOrchestrator';
import { generateAllMedia } from '../mediaGenerationEngine';
import { renderVideoForExport } from '../videoRenderEngine';
import { generateThumbnail } from '../thumbnailEngine';
import { publishToYoutube } from '../youtubePublishEngine';
import { getTopicSuggestions, startTopicSuggestion } from '../contentProgramManager';
import { STYLES } from '../pollinations';
import { MINIMAX_VOICES } from '../voiceProviders';

async function totalCostForVideo(channelId, videoId) {
  const { items: costItems } = await getCostsByChannel(channelId);
  return costItems.filter((c) => c.videoId === videoId).reduce((sum, c) => sum + (c.amountUsd || 0), 0);
}

let sceneIdCounter = 1;

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
function buildScenesFromRaw(rawScenes) {
  return (rawScenes || []).map((s) => ({
    id: sceneIdCounter++,
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
 * Returns { videoId, youtubeVideoId, costUsd } — no `inProgress` case (see header comment: nothing
 * in this recipe is ever left mid-flight across a resume boundary).
 */
export async function runStaticBackgroundPipeline(channel, { userId, onProgress, logStep }) {
  const channelId = channel.id;
  const settings = buildAutomationSettings(channel);
  let videoId = null;
  let project = null;
  let plan = null;
  let suggestion = null;
  const createdAt = Date.now();
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
      };

      await persist();
    });
    await logStep(channelId, videoId, 'outline', 'success', `${plan.outline.length} chapters, ${plan.totalScenes} scenes planned`);
    report('outline', 'Outline ready');
  } catch (err) {
    await logStep(channelId, videoId, 'outline', 'error', String(err?.message || err));
    throw err;
  }

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

      const { scenes: rawScenes, promisedFollowUp } = await generateAllScenes(plan.outline, context, (soFar, total) => {
        report('scenes', `${soFar.length}/${total} scenes written`);
        project = { ...project, scenes: buildScenesFromRaw(soFar) };
        persist().catch((err) => console.error('[staticBackgroundRecipe] partial scene save failed', err));
      });

      project = { ...project, scenes: buildScenesFromRaw(rawScenes), promisedFollowUp: promisedFollowUp || null };
      await persist();
    });
    await logStep(channelId, videoId, 'scenes', 'success', `${project.scenes.length} scenes generated`);
  } catch (err) {
    await logStep(channelId, videoId, 'scenes', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: media (voice only — no per-scene images for this content type) ----
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

  // ---- Phase: render ----
  let videoBlob;
  try {
    await withPhaseNetworkResilience('render', channelId, videoId, logStep, async () => {
      videoBlob = await renderVideoForExport(project, settings, {
        onProgress: (frameIndex, totalFrames) => report('render', `${Math.round((frameIndex / totalFrames) * 100)}%`),
      });
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

  // ---- Phase: thumbnail ----
  // A YouTube listing thumbnail is a distinct thing from the in-video static background — every
  // video needs one for the video's own listing regardless of content_type, so this phase is
  // identical to fullPipelineRecipe.js's (thumbnailEngine.js never looks at project.scenes[].images
  // at all — it works from project.thumbnails[thumbIdx], the outline's own thumbnail concepts).
  let thumbnailBlob;
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
    await logStep(channelId, videoId, 'thumbnail', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: YouTube ----
  // Deliberately NOT wrapped in withPhaseNetworkResilience — same duplicate-upload risk reasoning
  // as fullPipelineRecipe.js's identical phase.
  let youtubeVideoId = null;
  if (channel.automation_auto_publish === false) {
    await logStep(channelId, videoId, 'youtube', 'success', 'video ready for manual review — auto-publish disabled');
    report('youtube', 'Auto-publish disabled — ready for manual review');
  } else {
    try {
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
        onProgress: (evt) => {
          if (evt.kind === 'error') subErrors.push(`${evt.phase}: ${evt.message}`);
          if (evt.kind === 'upload-progress') report('youtube', `Uploading… ${evt.percent}%`);
        },
      });

      if (!youtubeVideoId) throw new Error(subErrors.find((m) => m.startsWith('upload:')) || 'YouTube upload failed');

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

  const costUsd = await totalCostForVideo(channelId, videoId);
  return { videoId, youtubeVideoId, costUsd };
}
