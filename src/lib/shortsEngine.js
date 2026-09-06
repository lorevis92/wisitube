// Companion YouTube Shorts.
//
// When a channel has automation_generate_shorts on, the recipes' YouTube phase — AFTER a long video
// has published successfully (so its watch URL exists) — call createShortRecord() to spin up a
// SEPARATE video record: a vertical 20-40s teaser with its own script and images, built to make
// someone who's never heard of the topic want the full story, and linking straight back to it.
//
// This module only PRODUCES THE RECORD (script via api/generate-outline mode:'short-script', scenes
// pre-written, description carrying the parent link + #Shorts). The recipe that called it then runs
// the new record through the exact same media → render → thumbnail → publish pipeline
// (runFullPipeline with targetVideoId) — no duplicated pipeline here. The record carries isShort:true
// so every path that later touches it (the recipe's format/anomalous-interruption handling, the
// Content Program Manager's anti-repetition filter) knows what it is.
import { createId, saveVideo } from './db';
import { STYLES } from './pollinations';

// Same transform api/generate-scenes.js's raw output gets everywhere else in this codebase
// (fullPipelineRecipe.js / staticBackgroundRecipe.js / App.jsx each keep their own copy — a pure,
// framework-free data transform, deliberately duplicated rather than shared). A Short is always a
// fresh record, so ids just run 1..N.
function buildScenesFromRaw(rawScenes) {
  return (rawScenes || []).map((s, sceneIdx) => {
    const beats = Array.isArray(s.image_beats) && s.image_beats.length ? s.image_beats.slice(0, 2) : [{}, {}];
    while (beats.length < 2) beats.push({});
    return {
      id: sceneIdx + 1,
      narration: s.narration || '',
      images: beats.map((b, beatIdx) => ({
        id: sceneIdx * 2 + beatIdx + 1,
        prompt: b.image_prompt || '',
        animation: b.animation || 'zoom_in',
        referenceId: null,
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

/**
 * parent: { id, youtubeVideoId, topic, angle, subject, characterBible, displayTitle } — the just-
 *   published long video. youtubeVideoId MUST be set (the Short links to it).
 * channel: the full channel record.
 * { userId, logStep }: userId is unused here (kept for signature parity with the recipe engines);
 *   logStep writes the one 'short' row.
 *
 * Returns the new Short video's id. Throws on script-generation / validation failure — the caller
 * wraps this so a failed Short never fails the (already-published) parent.
 */
export async function createShortRecord(parent, channel, { logStep } = {}) {
  if (!parent?.youtubeVideoId) throw new Error('parent video has no youtubeVideoId — cannot build a Short that links to it');

  const styleKey = channel.automation_image_provider ? channel.automation_style || 'facestick' : 'facestick';
  const styleLabel = (STYLES[styleKey] || STYLES.facestick).label;

  const res = await fetch('/api/generate-outline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'short-script',
      topic: parent.topic || parent.displayTitle || '',
      angle: parent.angle || '',
      parentTitle: parent.displayTitle || parent.topic || '',
      language: channel.automation_language || 'English',
      style: styleLabel,
      // Same provider as the parent (same visual style/consistency) — the parent used the channel's
      // configured provider, so the Short does too.
      imageProvider: channel.automation_image_provider || 'pollinations',
      characterBible: Array.isArray(parent.characterBible) ? parent.characterBible : [],
      creativeOverride: channel.prompt_overrides?.shortScript || null,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || 'Short script generation failed');

  const scenes = buildScenesFromRaw(data.scenes || []);
  if (scenes.length < 4) throw new Error(`Short script produced only ${scenes.length} scenes`);

  const characterBible = (data.character_bible || parent.characterBible || []).map((c) => ({
    id: c.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random())),
    name: c.name || '',
    baseDescription: c.baseDescription || c.base_description || '',
    variants: Array.isArray(c.variants)
      ? c.variants.map((v) => ({ label: v.label || '', description: v.description || '' }))
      : [],
  }));

  const parentUrl = `https://www.youtube.com/watch?v=${parent.youtubeVideoId}`;
  const teaser = (data.description || '').trim() || `The wild story behind ${parent.displayTitle || parent.topic}.`;
  const description = `${teaser}\n\n▶ Watch the full story: ${parentUrl}\n\n#Shorts`;
  const tags = [...new Set([...(Array.isArray(data.tags) ? data.tags : []), 'Shorts', 'YouTubeShorts'])]
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(0, 15);
  const shortTitle =
    (typeof data.title === 'string' && data.title.trim()) ||
    `${parent.displayTitle || parent.topic || 'The story'} — in 30 seconds #Shorts`.slice(0, 100);

  const shortId = createId();
  const createdAt = Date.now();
  await saveVideo({
    id: shortId,
    channelId: channel.id,
    createdAt,
    topic: parent.topic || parent.displayTitle || '',
    displayTitle: shortTitle,
    // The recipe forces settings.format = '9:16' for any isShort video regardless of this — kept
    // here so a manual "open in Storyboard/Export" of the Short also sees the right aspect ratio.
    settings: { format: '9:16', imageProvider: channel.automation_image_provider || 'pollinations' },
    titles: [shortTitle],
    selectedTitle: 0,
    description,
    tags,
    thumbnails: Array.isArray(data.thumbnail_concepts) ? data.thumbnail_concepts : [],
    subtitles: true,
    references: [],
    characterBible,
    scenes,
    series: null,
    outline: [{ id: 'ch1_short', title: 'Teaser', summary: 'Standalone teaser for the full video.', scene_count: scenes.length }],
    totalScenes: scenes.length,
    // A record an automatic cycle / the poll may resume later, exactly like a normal automation video.
    createdByAutomation: true,
    // Shares the parent's subject ON PURPOSE — the Content Program Manager filters isShort videos out
    // of its anti-repetition signals so this never reads as "already covering this topic".
    subject: parent.subject || null,
    isShort: true,
    parentVideoId: parent.id,
  });

  await logStep?.(
    channel.id,
    shortId,
    'short',
    'success',
    `created teaser Short (${scenes.length} scenes) for "${parent.displayTitle || parent.topic}"`
  );

  return shortId;
}
