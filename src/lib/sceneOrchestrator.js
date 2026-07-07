// Drives api/generate-scenes.js across an entire outline: each chapter's scene_count is split
// into calls of at most MAX_SCENES_PER_CALL scenes, the narration handed continuity via
// previousTail so the voiceover reads as one continuous script rather than disjointed fragments.

const MAX_SCENES_PER_CALL = 16;
const RETRY_BACKOFF_MS = 3000;
// Shared cap for every paid-provider concurrency pool below (images via nanobanana/gptimage,
// audio via MiniMax) — free/local engines (Pollinations, Kokoro) stay serial and untouched.
export const MAX_PAID_CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry with a fixed backoff, shared by scene generation and image generation below — a
// second failure propagates to the caller (for scenes, that's after every prior successful chunk
// has already been handed over via onProgress, so no completed work is lost).
async function withRetry(fn) {
  try {
    return await fn();
  } catch {
    await sleep(RETRY_BACKOFF_MS);
    return await fn();
  }
}

async function callGenerateScenes(payload) {
  const res = await fetch('/api/generate-scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Scene generation failed');
  if (!Array.isArray(data.scenes) || !data.scenes.length) throw new Error('Scene generation returned no scenes');
  return data.scenes;
}

// A chapter with more scenes than the per-call cap becomes several chunks, the last one taking
// whatever remains rather than every chunk being forced to an equal size.
function splitIntoChunkSizes(sceneCount) {
  const sizes = [];
  let remaining = sceneCount;
  while (remaining > 0) {
    const size = Math.min(MAX_SCENES_PER_CALL, remaining);
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

/**
 * outline: [{ id, title, summary, scene_count }]
 * context: { topic, title, language, style, format, imageProvider, characterBible, references }
 * onProgress(scenesSoFar, totalScenes): called after every successful chunk with the full
 * accumulated scenes array so far — safe for the caller to both derive a progress count from
 * (scenesSoFar.length) and persist as partial, resumable state.
 */
export async function generateAllScenes(outline, context, onProgress) {
  const chapters = Array.isArray(outline) ? outline : [];
  const totalScenes = chapters.reduce((a, c) => a + (Number(c.scene_count) || 0), 0);

  // Flatten (chapter, chunk size) into one ordered job list so "first chunk of the whole video"
  // and "last chunk of the whole video" can be determined without nested-loop bookkeeping.
  const jobs = [];
  chapters.forEach((chapter) => {
    splitIntoChunkSizes(Number(chapter.scene_count) || 0).forEach((size) => jobs.push({ chapter, size }));
  });

  const allScenes = [];
  let previousTail = null;

  for (let i = 0; i < jobs.length; i++) {
    const { chapter, size } = jobs[i];
    const scenes = await withRetry(() => callGenerateScenes({
      topic: context.topic,
      title: context.title,
      chapterTitle: chapter.title,
      chapterSummary: chapter.summary,
      sceneCount: size,
      language: context.language,
      style: context.style,
      format: context.format,
      imageProvider: context.imageProvider,
      characterBible: context.characterBible,
      references: context.references,
      previousTail,
      isVeryFirstChunk: i === 0,
      isVeryLastChunk: i === jobs.length - 1,
    }));

    allScenes.push(...scenes);
    previousTail = scenes[scenes.length - 1]?.narration || previousTail;

    if (onProgress) onProgress(allScenes.slice(), totalScenes || allScenes.length);
  }

  return allScenes;
}

async function callGenerateImage(payload) {
  const res = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Image generation failed');
  if (!data.imageUrl) throw new Error('Image generation returned no image URL');
  return data;
}

/**
 * prompt: final, provider-appropriate prompt string (see promptBuilders.js)
 * provider: 'pollinations' | 'nanobanana' | 'gptimage'
 * referenceImages: array of data-URI or plain-URL strings, optional
 * opts: { width, height, seed, quality }
 * Returns { imageUrl, provider, costUsd }. Same one-retry-with-backoff resilience as scene calls.
 */
export async function generateImage(prompt, provider, referenceImages, opts = {}) {
  const payload = { provider, prompt, referenceImages: referenceImages || [], ...opts };
  return withRetry(() => callGenerateImage(payload));
}

async function callGenerateAudio(payload) {
  const res = await fetch('/api/generate-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Audio generation failed');
  if (!data.audioUrl) throw new Error('Audio generation returned no audio URL');
  return data;
}

/**
 * text: narration to synthesize
 * voice: MiniMax voice_id
 * opts: { language }
 * Returns { audioUrl, costUsd }. Same one-retry-with-backoff resilience as scene/image calls.
 */
export async function generateAudio(text, voice, opts = {}) {
  const payload = { text, voice, ...opts };
  return withRetry(() => callGenerateAudio(payload));
}

/**
 * Minimal concurrency-limited task runner for paid providers — no external dependency, just a
 * slot-releasing queue: each of `concurrency` parallel loops pulls the next available item as
 * soon as its previous one settles. Free/local engines (Pollinations, Kokoro) never use this —
 * they stay strictly serial by simply not calling it.
 */
export async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
}
