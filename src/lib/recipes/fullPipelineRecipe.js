// Full pipeline recipe for the automation engine — Phase 2a: real generation, composing the same
// engine modules the manual UI already uses (mediaGenerationEngine.js, videoRenderEngine.js,
// thumbnailEngine.js, youtubePublishEngine.js, sceneOrchestrator.js). No new generation logic lives
// here — this file only sequences existing, already-exercised building blocks and persists the
// video record at each checkpoint, so a failure partway leaves a resumable record behind for manual
// review in the regular Storyboard/Editor/Export UI instead of vanishing.
//
// Every phase logs exactly once via the injected logStep(channelId, videoId, step, status,
// message) — 'success' on completion, 'error' right before re-throwing — and a failure in any
// phase stops the whole recipe immediately: later phases never run against an incomplete video.
import { createId, saveVideo, listVideosByChannel, getCostsByChannel } from '../db';
import { uploadMedia } from '../mediaStorage';
import { generateAllScenes } from '../sceneOrchestrator';
import { generateAllMedia } from '../mediaGenerationEngine';
import { renderVideoForExport } from '../videoRenderEngine';
import { generateThumbnail } from '../thumbnailEngine';
import { publishToYoutube, listChannelPlaylists } from '../youtubePublishEngine';
import { STYLES } from '../pollinations';
import { MINIMAX_VOICES } from '../voiceProviders';

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

// Applies one mediaGenerationEngine.js onProgress event to a local project copy — the same
// per-beat/per-scene patch shape StoryboardStep.jsx's updateImage/updateScene apply to React state.
// Needed here because generateAllMedia only reports through onProgress (there's no React state to
// read back from in a headless caller), and this recipe has to know the final per-beat/per-scene
// status afterward to detect partial failures generateAllMedia doesn't throw for on its own (a
// single failed beat just stays 'error', silently).
function applyMediaProgress(project, evt) {
  if (evt.kind === 'beat') {
    return {
      ...project,
      scenes: project.scenes.map((s) =>
        s.id === evt.sceneId ? { ...s, images: s.images.map((im, i) => (i === evt.beatIndex ? { ...im, ...evt.patch } : im)) } : s
      ),
    };
  }
  if (evt.kind === 'scene') {
    return { ...project, scenes: project.scenes.map((s) => (s.id === evt.sceneId ? { ...s, ...evt.patch } : s)) };
  }
  return project;
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
 * Returns { videoId, youtubeVideoId, costUsd } on full success. Throws on the first phase failure;
 * whatever was saved via saveVideo up to that point stays on the record for manual review in the
 * regular Storyboard/Editor/Export UI — nothing is rolled back or deleted.
 */
export async function runFullPipeline(channel, { userId, onProgress, logStep }) {
  const channelId = channel.id;
  const settings = buildAutomationSettings(channel);
  // Declared here (rather than at their original spot further down) so report() can close over
  // them from the very first call — both stay null until the phases that create them run, which
  // is fine: the mirror view (AutomationMirrorStep.jsx) only reads project once phase === 'media'.
  let videoId = null;
  let project = null;
  const report = (step, message) => onProgress?.({ step, message, videoId, project });

  // ---- Phase: suggestion ----
  let suggestion;
  try {
    suggestion = await withPhaseNetworkResilience('suggestion', channelId, null, logStep, async () => {
      const existingVideos = await listVideosByChannel(channelId);
      // Enrichment, not a required step — listChannelPlaylists already swallows its own failures
      // and returns [] rather than throwing, so this never blocks the suggestion phase on its own.
      const existingPlaylists = await listChannelPlaylists(channel);
      const res = await fetch('/api/program-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: channel.name,
          niche: channel.niche || '',
          editorialNotes: channel.editorialNotes || '',
          existingVideos: existingVideos.map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
          refinement: '',
          creativeOverride: channel.prompt_overrides?.programManager || null,
          activeDirective: channel.automation_directive || '',
          existingPlaylists,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Content Program Manager request failed');
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      if (!suggestions.length) throw new Error('Content Program Manager returned no suggestions');
      return suggestions.find((s) => s.priority === 'high') || suggestions[0];
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
  const createdAt = Date.now();
  // Shared by every saveVideo call below — reads whatever `project`/`plan` are in scope at call
  // time, so each phase just has to update those two variables before persisting.
  project = { titles: [suggestion.title], selectedTitle: 0, series: suggestion.series || null };
  let plan = null;
  const persist = () =>
    saveVideo({
      id: videoId,
      channelId,
      createdAt,
      updatedAt: Date.now(),
      topic: suggestion.title,
      settings,
      ...project,
      displayTitle: plan?.title || suggestion.title,
    });

  try {
    await withPhaseNetworkResilience('video-record', channelId, videoId, logStep, persist);
    await logStep(channelId, videoId, 'video-record', 'success', 'created video record');
    report('video-record', 'Created video record');
  } catch (err) {
    await logStep(channelId, videoId, 'video-record', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: outline ----
  try {
    await withPhaseNetworkResilience('outline', channelId, videoId, logStep, async () => {
      const res = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: suggestion.title,
          title: suggestion.title,
          angle: suggestion.angle || '',
          language: settings.language,
          lengthMinutes: settings.lengthMinutes,
          style: STYLES[settings.style].label,
          imageProvider: settings.imageProvider,
          characterHints: [],
          generalNotes: '',
          references: [],
          creativeOverride: channel.prompt_overrides?.outline || null,
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
        characterBible: plan.characterBible,
        references: [],
        creativeOverride: channel.prompt_overrides?.scenes || null,
      };

      const rawScenes = await generateAllScenes(plan.outline, context, (soFar, total) => {
        report('scenes', `${soFar.length}/${total} scenes written`);
        project = { ...project, scenes: buildScenesFromRaw(soFar) };
        persist().catch((err) => console.error('[fullPipelineRecipe] partial scene save failed', err));
      });

      project = { ...project, scenes: buildScenesFromRaw(rawScenes) };
      await persist();
    });
    await logStep(channelId, videoId, 'scenes', 'success', `${project.scenes.length} scenes generated`);
  } catch (err) {
    await logStep(channelId, videoId, 'scenes', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: media (images + audio) ----
  try {
    await withPhaseNetworkResilience('media', channelId, videoId, logStep, async () => {
      await generateAllMedia(project, {
        settings,
        channelId,
        userId,
        videoId,
        onProgress: (evt) => {
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
        },
      });

      const allReady = project.scenes.every((s) => s.audioStatus === 'ready' && s.images.every((im) => im.status === 'ready'));
      if (!allReady) throw new Error('Some scenes failed to generate media (image or audio)');

      await persist();
    });
    await logStep(channelId, videoId, 'media', 'success', 'all images and audio generated');
    report('media', 'Media complete');
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
    // fallback opportunity — a known Phase 2a limitation, not an oversight.
    await logStep(channelId, videoId, 'render', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: thumbnail ----
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
  // Deliberately NOT wrapped in withPhaseNetworkResilience, unlike every other phase: a network
  // error here can happen AFTER the upload already reached YouTube (the request succeeded
  // server-side but the response was lost to the same drop) — retrying the whole phase risks
  // publishing the same video twice. A duplicate public upload is a worse outcome than a failed
  // cycle, so this phase fails immediately on any error (network or not) and asks for a manual
  // check instead of an automatic retry.
  let youtubeVideoId = null;
  if (channel.automation_auto_publish === false) {
    // Auto-publish is off for this channel — the video is already fully produced (render +
    // thumbnail are done and persisted above), it just never goes near YouTube's API. Leaves it
    // exactly where a manually-created video would sit: reviewable and independently publishable
    // by hand from Storyboard/Editor/Export. automation_daily_upload_count still increments in
    // automationEngine.js after this returns — it counts videos *produced*, not videos published.
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
  // (inside mediaGenerationEngine.js/thumbnailEngine.js) — not tracked incrementally here since
  // those writes happen deep inside modules this recipe doesn't otherwise need to instrument.
  const { items: costItems } = await getCostsByChannel(channelId);
  const costUsd = costItems.filter((c) => c.videoId === videoId).reduce((sum, c) => sum + (c.amountUsd || 0), 0);

  return { videoId, youtubeVideoId, costUsd };
}
