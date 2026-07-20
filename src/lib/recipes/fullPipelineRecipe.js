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
import { publishToYoutube } from '../youtubePublishEngine';
import { STYLES } from '../pollinations';
import { MINIMAX_VOICES } from '../voiceProviders';

let sceneIdCounter = 1;
let beatIdCounter = 1;

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

// Applies one mediaGenerationEngine.js onProgress event to a local project copy — same reducer
// shape generateSceneMedia uses internally. Needed here because generateAllMedia only reports
// through onProgress (there's no React state to read back from in a headless caller), and this
// recipe has to know the final per-beat/per-scene status afterward to detect partial failures
// generateAllMedia doesn't throw for on its own (a single failed beat just stays 'error', silently).
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

// Hardcoded until the Automation tab grows dedicated style/language/voice pickers — flagged to the
// user, same as the YouTube category default below. Mirrors App.jsx's own settings defaults for a
// brand-new manual video, so automated videos look/sound like what a first-time manual user gets
// without touching any advanced settings.
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
  return {
    style: DEFAULT_STYLE,
    language: DEFAULT_LANGUAGE,
    format: DEFAULT_FORMAT,
    imageProvider: channel.automation_image_provider || 'pollinations',
    voiceEngine,
    voice: voiceEngine === 'minimax' ? MINIMAX_VOICES[0].id : DEFAULT_KOKORO_VOICE,
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
  const report = (step, message) => onProgress?.({ step, message });

  // ---- Phase: suggestion ----
  let suggestion;
  try {
    const existingVideos = await listVideosByChannel(channelId);
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
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Content Program Manager request failed');
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!suggestions.length) throw new Error('Content Program Manager returned no suggestions');
    suggestion = suggestions.find((s) => s.priority === 'high') || suggestions[0];
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
  const videoId = createId();
  const createdAt = Date.now();
  // Shared by every saveVideo call below — reads whatever `project`/`plan` are in scope at call
  // time, so each phase just has to update those two variables before persisting.
  let project = { titles: [suggestion.title], selectedTitle: 0, series: suggestion.series || null };
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
    await persist();
    await logStep(channelId, videoId, 'video-record', 'success', 'created video record');
    report('video-record', 'Created video record');
  } catch (err) {
    await logStep(channelId, videoId, 'video-record', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: outline ----
  try {
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
    await logStep(channelId, videoId, 'outline', 'success', `${plan.outline.length} chapters, ${plan.totalScenes} scenes planned`);
    report('outline', 'Outline ready');
  } catch (err) {
    await logStep(channelId, videoId, 'outline', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: scenes ----
  try {
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
    await logStep(channelId, videoId, 'scenes', 'success', `${project.scenes.length} scenes generated`);
  } catch (err) {
    await logStep(channelId, videoId, 'scenes', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: media (images + audio) ----
  try {
    await generateAllMedia(project, {
      settings,
      channelId,
      userId,
      videoId,
      onProgress: (evt) => {
        project = applyMediaProgress(project, evt);
        if (evt.kind === 'message' && evt.text) report('media', evt.text);
      },
    });

    const allReady = project.scenes.every((s) => s.audioStatus === 'ready' && s.images.every((im) => im.status === 'ready'));
    if (!allReady) throw new Error('Some scenes failed to generate media (image or audio)');

    await persist();
    await logStep(channelId, videoId, 'media', 'success', 'all images and audio generated');
    report('media', 'Media complete');
  } catch (err) {
    await logStep(channelId, videoId, 'media', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: render ----
  let videoBlob;
  try {
    videoBlob = await renderVideoForExport(project, settings, {
      onProgress: (frameIndex, totalFrames) => report('render', `${Math.round((frameIndex / totalFrames) * 100)}%`),
    });
    project = { ...project, renderedVideoBlob: videoBlob };
    await persist();
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
    await logStep(channelId, videoId, 'thumbnail', 'success', 'thumbnail created');
    report('thumbnail', 'Thumbnail ready');
  } catch (err) {
    await logStep(channelId, videoId, 'thumbnail', 'error', String(err?.message || err));
    throw err;
  }

  // ---- Phase: YouTube ----
  let youtubeVideoId;
  try {
    const metadata = {
      title: plan.title,
      description: plan.description,
      tags: plan.tags,
      categoryId: DEFAULT_YOUTUBE_CATEGORY_ID,
      language: YOUTUBE_LANGUAGE_CODES[settings.language] || 'en',
      privacyStatus: 'public',
      scheduleMode: 'now',
      publishAt: null,
      madeForKids: false,
      uploadCaptions: true,
      addToPlaylist: !!suggestion.series,
    };

    // publishToYoutube never throws for a degraded (but non-fatal) thumbnail/captions/playlist
    // phase — same as the manual UI, where each of those stays independently retryable and doesn't
    // block the upload that already succeeded. Collected here only to attach a warning to the
    // 'success' log message, not to fail the phase outright.
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

    const message = subErrors.length ? `published (${youtubeVideoId}) with issues: ${subErrors.join('; ')}` : `published (${youtubeVideoId})`;
    await logStep(channelId, videoId, 'youtube', 'success', message);
    report('youtube', 'Published to YouTube');
  } catch (err) {
    await logStep(channelId, videoId, 'youtube', 'error', String(err?.message || err));
    throw err;
  }

  // Total real spend for this video, from the cost-ledger entries recordCost wrote along the way
  // (inside mediaGenerationEngine.js/thumbnailEngine.js) — not tracked incrementally here since
  // those writes happen deep inside modules this recipe doesn't otherwise need to instrument.
  const { items: costItems } = await getCostsByChannel(channelId);
  const costUsd = costItems.filter((c) => c.videoId === videoId).reduce((sum, c) => sum + (c.amountUsd || 0), 0);

  return { videoId, youtubeVideoId, costUsd };
}
