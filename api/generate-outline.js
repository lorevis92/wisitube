// WisiTube — Outline generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Second stage of the titles → outline → scenes pipeline. Runs AFTER the user has picked a title
// and its narrative angle — everything here is anchored to that specific angle, not a generic
// treatment of the topic. Produces the SEO pack, the character bible (with web search enabled, same
// as the old single-call api/generate.js), and a chapter outline whose scene_count fields the
// client will later split into individual api/generate-scenes.js calls.
//
// Also serves STAGE 1 of the same pipeline — the titles call (body.mode === 'titles', dispatched to
// generateTitles below) — folded in from the former api/generate-titles.js to stay under Vercel
// Hobby's 12-function cap (see scripts/check-function-count.js). The two stages share nothing but
// the ANTHROPIC_API_KEY and this file.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 120 };

// ---- Stage 1: titles (was api/generate-titles.js) ----
//
// A short, fast call that lets the user pick a title and its narrative angle before any of the
// heavier outline/scene-writing work runs.

// The "channel voice" half of the titles system prompt — safe to override per-channel (nothing
// here constrains the output format, so swapping it can't break downstream parsing).
const TITLES_DEFAULT_CREATIVE_DIRECTION = `You are a YouTube strategist for successful faceless animated channels. Given a topic, propose 5 distinct, highly clickable video titles — max 70 chars each.

Every title MUST do BOTH of these at once, never only one:
1. Name the real subject explicitly, by its proper name — the specific person, place, law, event, organisation, or named phenomenon the video is actually about. If a viewer couldn't say what the video is about before clicking, the title is too vague no matter how intriguing it sounds.
2. Carry a real curiosity hook — a surprising claim, a tension, or a question that makes the specific outcome feel worth watching. A flat encyclopedic label is not a title.

WRONG (vague — no identifiable subject): "The Scientist Whose Invention Fed Billions and Killed Millions"
RIGHT (proper name + hook): "Fritz Haber: The Chemist Who Fed the World, Then Gassed It"

WRONG (vague): "The Tiny Nation That Got Impossibly Rich"
RIGHT: "How Singapore Went From Swamp to the Richest City on Earth"

Each title implies a specific narrative angle (what the video will actually focus on), and the 5 angles must be genuinely different from each other — not reworded versions of the same idea. For each title, write "angle": one short phrase naming that specific narrative cut (e.g. for the title "Why Napoleon Lost in Russia" the angle is "focus on the strategic blunder"; for "The Winter That Destroyed an Empire" the angle is "focus on human suffering").`;

// The output-format half — NEVER influenced by creativeOverride: the client's JSON parsing depends
// on this exact shape regardless of what creative direction is in play. "subject" is a
// comparison-only field (anti-repetition — see src/lib/contentProgramManager.js), never displayed.
const TITLES_SCHEMA_INSTRUCTIONS = `You MUST respond with ONLY valid JSON, no markdown, no preamble. Schema: { "titles": [5 objects: { "title": string, "angle": string, "subject": string }] }. "subject" is the bare proper name of what the video is about — just the name, no framing words, no verbs, no leading article (e.g. "Fritz Haber", "Singapore", "ammonium nitrate", "the Antikythera mechanism"). It exists only to detect two videos covering the same thing and is never shown to anyone.`;

async function generateTitles(req, res, apiKey) {
  try {
    let topic, language, creativeOverride;
    try {
      const body = req.body || {};
      topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      if (!topic || topic.length > 500) return res.status(400).json({ error: 'Invalid topic' });
      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';
    } catch (err) {
      console.error('[generate-titles] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const systemPrompt = `${creativeOverride || TITLES_DEFAULT_CREATIVE_DIRECTION} ${TITLES_SCHEMA_INSTRUCTIONS}`;

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Topic: "${topic}". Narration language: ${language}. Respond with JSON only.` }],
        }),
      });
    } catch (err) {
      console.error('[generate-titles] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[generate-titles] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[generate-titles] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-titles] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    let raw;
    try {
      raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } catch (err) {
      console.error('[generate-titles] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[generate-titles] phase=locate-json no braces found, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[generate-titles] phase=parse-plan-json', e?.message, 'raw text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.titles) || plan.titles.length === 0) {
      console.error('[generate-titles] phase=validate-plan missing/empty titles, plan=', JSON.stringify(plan).slice(0, 300));
      return res.status(502).json({ error: 'AI response missing titles' });
    }

    // Normalize each title object — subject is optional from the model's side (if it's omitted the
    // anti-repetition check just falls back to title comparison for that video), but always
    // present and trimmed in the response so the client never has to guard against undefined.
    plan.titles = plan.titles
      .map((t) => ({
        title: typeof t?.title === 'string' ? t.title.trim() : '',
        angle: typeof t?.angle === 'string' ? t.angle.trim() : '',
        subject: typeof t?.subject === 'string' ? t.subject.trim() : '',
      }))
      .filter((t) => t.title);
    if (!plan.titles.length) {
      console.error('[generate-titles] phase=validate-plan no usable titles after normalize');
      return res.status(502).json({ error: 'AI response missing titles' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-titles] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// The "channel voice" half of the system prompt — tone, editorial priorities, how to approach
// outline pacing and character-bible writing. Safe to override per-channel (see creativeOverride
// below): no required JSON field name or hard correctness rule lives here, only guidance on how to
// write. Deliberately has no per-request interpolation (title/angle/length/style) — those are
// facts about this specific video, not stylistic choices, so they're always injected separately
// (see the `context` constant below) regardless of whether this default or a channel's override is active.
const DEFAULT_CREATIVE_DIRECTION = `You are a YouTube strategist and scriptwriter for successful faceless animated channels.

Everything you produce must be built AROUND the video's specific narrative angle, not a generic treatment of the topic. Structure the outline so each chapter has a clear role in the narrative arc: the first chapter is the HOOK (open with the angle's most surprising fact or question), middle chapters develop and escalate the angle, the last chapter is the climax and closes with a call to action (subscribe / watch next). Give the last chapter a couple more scenes than a strict pacing formula alone would suggest — it needs room for a brief closing recap (the key takeaway plus a callback to the story's turning point) before the call-to-action, without feeling rushed or crowded. Every chapter must build on the last, staying anchored to the chosen angle throughout — never drift into a generic retelling of the topic.

For the character bible: identify every character that appears in more than one scene across the ENTIRE video — including the narrator/protagonist even if not explicitly named by the user. If the user provided character hints, prioritize those details over your own assumptions. Create at least 2 variants when the story spans different life stages, time periods, or notable appearance changes (e.g. young vs old, before/after a transformation) — otherwise a single variant is enough. Every variant must preserve the base_description's core identifying traits while adapting era-specific details, so the character stays recognizable across variants.

For every real, named, identifiable person in the character_bible (historical figures, celebrities, public figures) — search the web to verify their actual physical appearance before writing descriptions. Identify which traits are constant identity anchors that persist across their entire life (bone structure, ear shape, distinctive permanent marks, eye shape/color, general build proportions) versus which traits change by era (hair length/color/style, facial hair, weight, clothing, age-related features). The base_description must contain only the constant anchors. Each variant's description must contain only the era-specific changes — never repeat the constant anchors in variants, they're inherited automatically. For fictional characters or figures the search doesn't surface reliable information about, fall back on your own knowledge or reasonable invention guided by any user-provided character hints. Keep base_description and every variant description short and telegraphic — max 12-15 words each, comma-separated traits, never a full discursive sentence — since these get concatenated directly into image-generation prompts and must stay lean.`;

// Same "channel voice" role as DEFAULT_CREATIVE_DIRECTION above, for content_type
// 'static_background' — no per-scene images exist in this mode, so the character-bible guidance
// (and the narrative-arc guidance generally) drops every mention of visual appearance/art style,
// keeping character_bible purely as a naming/identity aid for consistent narration.
const DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND = `You are a scriptwriter for spoken-narration, language-learning videos with a static background — there is no per-scene visual component, only continuous narration meant to be listened to and read along.

Everything you produce must be built AROUND the video's specific narrative angle, not a generic treatment of the topic. Structure the outline so each chapter has a clear role in the narrative arc: the first chapter is the HOOK, middle chapters develop and escalate the angle, the last chapter is the climax and closes with a call to action (subscribe / watch next). Give the last chapter a couple more scenes than a strict pacing formula alone would suggest — it needs room for a brief closing recap (the key takeaway plus a callback to the story's turning point) before the call-to-action, without feeling rushed or crowded. Every chapter must build on the last, staying anchored to the chosen angle throughout — never drift into a generic retelling of the topic.

For the character bible: identify every recurring named person across the ENTIRE video — including the narrator/protagonist even if not explicitly named by the user. This exists only to keep names, roles and relationships consistent across the narration (e.g. always referring to the same person the same way) — there is no visual appearance to describe, so keep base_description and variants brief and focused on identity/role/relationship, never physical traits.`;

// "Let AI decide the ideal length" mode (CreateStep.jsx/AutomationStep.jsx) — replaces the fixed
// lengthMinutes-driven scene count with purely content-driven pacing. Deliberately says nothing
// about topic "category" (history vs. science vs. whatever) — that's exactly the kind of shortcut
// that leads to padding a thin topic or rushing a rich one just to hit an assumed norm.
const AI_DECIDES_LENGTH_INSTRUCTION = `Determine the ideal length for this video based purely on how much genuinely interesting, non-redundant, useful content exists for this specific topic — not on any assumption about what 'category' of topic this is. Mentally list the distinct facts, angles, or story beats truly worth including; if that list is short, the video should be short; if it's rich, it should be longer. Never pad with repetition or filler to reach any particular length, and never omit worthwhile content just to shorten it. Optimize purely for narrative completeness and density of value to the viewer.`;

// Adjusts ONLY the last chapter's scene_count to bring the outline's actual total back inside
// [capMinScenes, capMaxScenes] — never a proportional trim/stretch across every chapter, which
// would disturb the pacing/balance of chapters that were already fine. A model that ignored the
// cap instruction in the prompt (it can happen) gets corrected here, at the closing chapter only —
// shortening or lengthening the ending is far less disruptive to the narrative than reshaping the
// hook or the middle chapters. Mutates plan.outline in place and refreshes plan.total_scenes to
// match the (possibly adjusted) real sum.
// ---- Stage: short-script (body.mode === 'short-script') ----
//
// Folded into this file (same dispatch pattern as `titles`) to stay under Vercel Hobby's 12-function
// cap. Generates the COMPLETE script for a companion YouTube Short in one call — description, SEO
// pack, thumbnail concepts, and 6-10 fully-written scenes (narration + 2 image_beats each, exactly
// the api/generate-scenes.js output shape src/lib/shortsEngine.js's buildScenesFromRaw consumes).
// The character bible is INHERITED from the just-published long video, not re-invented, so the Short
// depicts the same people consistently. There is no web search here — everything it needs is in the
// request.
const SHORT_SCRIPT_DIRECTION = `You are a YouTube Shorts scriptwriter for a faceless animated channel.

Write a short, self-contained 20-40 second story that creates genuine curiosity about the topic and ends with an explicit, natural call-to-action pointing the viewer to the full video. This is NOT a summary or a repeat of the full video's opening — it is a standalone teaser designed to make someone who has never heard of this topic want to know more.

Craft: open on the single most surprising, specific hook in the first sentence (no throat-clearing). Build one small thread of intrigue across the middle scenes — a question, a tension, a "wait, what?" moment — without ever resolving it.

The final 1-2 scenes must land a clear, spoken call-to-action that tells the viewer EXACTLY where to find the full video: it lives in the description / the pinned link, not somewhere they have to search for. YouTube Shorts can't auto-play the next video or show a clickable card, so a generic "watch the full video" leaves them stuck — the CTA must name the location. Phrase it naturally, as spoken narration, never as a mechanical command or an on-screen caption. Good: "the full story is wild, and the whole video is linked right in the description", "there's so much more to this, tap the link in the description to watch it all", "I put the full breakdown in the description below". Bad: "watch the full video", "check out the complete story", "link in bio".

Narration: conversational, punchy, read-aloud friendly, no scene numbers, no dashes as punctuation. Each scene is 1-2 very short sentences. Vary the animations; never repeat one across consecutive scenes. Each scene's two image_beats must be visually distinct from each other (different subject, moment, or framing).`;

async function generateShortScript(req, res, apiKey) {
  try {
    let topic, angle, parentTitle, language, style, imageProvider, characterBible, creativeOverride;
    try {
      const body = req.body || {};
      topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      angle = typeof body.angle === 'string' ? body.angle.trim() : '';
      parentTitle = typeof body.parentTitle === 'string' ? body.parentTitle.trim() : '';
      if (!topic || topic.length > 500) return res.status(400).json({ error: 'Invalid topic' });
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'stick figures';
      imageProvider = typeof body.imageProvider === 'string' ? body.imageProvider.trim() : 'pollinations';
      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';
      characterBible = Array.isArray(body.characterBible)
        ? body.characterBible
            .filter((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim())
            .slice(0, 12)
            .map((c) => ({
              id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : '',
              name: c.name.trim(),
              baseDescription: typeof c.baseDescription === 'string' ? c.baseDescription.trim() : '',
              variants: Array.isArray(c.variants)
                ? c.variants
                    .map((v) => ({
                      label: typeof v?.label === 'string' ? v.label.trim() : '',
                      description: typeof v?.description === 'string' ? v.description.trim() : '',
                    }))
                    .filter((v) => v.label)
                : [],
            }))
        : [];
    } catch (err) {
      console.error('[generate-short-script] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Pollinations (Flux/Kontext) has no world knowledge and can't render legible text; Nano Banana /
    // GPT Image recognize named people and render text — same split as api/generate-scenes.js.
    const premiumProvider = ['nanobanana', 'nanobanana-batch', 'gptimage'].includes(imageProvider);
    const imagePromptFieldDescription = premiumProvider
      ? `concrete visual description in English of ONE clear vertical (9:16) image for a specific moment in this narration: one subject, one action, simple composition. Write it as a natural sentence that names any recognizable real person or character by their proper name (trust the model's own knowledge for their look). No on-screen text unless a specific number/quote in the narration genuinely needs it, in which case give the exact text in quotes and say it must be rendered verbatim.`
      : `concrete visual description in English of ONE clear vertical (9:16) image for a specific moment in this narration: one subject, one action, simple composition. Never include text, letters, numbers or signs in the image.`;

    const characterContext = characterBible.length
      ? `

These characters are ALREADY established in the full video — use the SAME ids and names, do not invent new ones. Set image_beats.character_id to the matching id (and variant_label to a matching variant, or null) for every beat a listed character appears in:
${characterBible
  .map(
    (c) =>
      `- id: "${c.id}", name: "${c.name}"${c.baseDescription ? ` — ${c.baseDescription}` : ''}${
        c.variants.length ? `; variants: [${c.variants.map((v) => `"${v.label}"`).join(', ')}]` : ''
      }`
  )
  .join('\n')}`
      : '';

    const SCHEMA = `You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble. Just raw JSON.

{
  "title": "punchy Short title, max 90 chars, curiosity-driven",
  "description": "2-3 sentence YouTube description written to tease the full video (the app appends the full-video link and #Shorts itself — do NOT add them)",
  "tags": [8-12 short SEO tag strings],
  "thumbnail_concepts": [EXACTLY 3 objects, never fewer: { "overlay_text": "punchy text max 4 words UPPERCASE", "image_prompt": "concrete visual description in English for an AI image generator, framed as a vertical 9:16 portrait: one strong focal subject filling the frame, exaggerated emotion, high contrast, no text in the image. If a real, identifiable person or a well-known named character is central to this Short, that focal subject MUST be named explicitly by their proper name (e.g. \\"Elon Musk with a shocked expression, plunging red stock-market graphs behind him\\") — never a generic stand-in like \\"a businessman\\" or \\"a shocked man\\"" }],
  "character_bible": [the SAME array you were given above, unchanged, or [] if none was given],
  "scenes": [between 6 and 10 objects: {
    "narration": "what the voiceover says for this scene — 1-2 very short sentences, max 150 characters, written in ${language}, no dashes as punctuation",
    "image_beats": [exactly 2 objects: {
      "image_prompt": "${imagePromptFieldDescription}",
      "animation": one of "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "drift_up" | "static",
      "reference_id": null,
      "character_id": string | null,
      "variant_label": string | null
    }]
  }]
}

Rules:
- Between 6 and 10 scenes, no more, no less.
- image_prompt is always in English regardless of narration language, and must render well as a vertical 9:16 frame.
- reference_id is always null.
- thumbnail_concepts is REQUIRED and MUST contain exactly 3 objects — never omit it, never leave it empty. When this Short centers on a real, identifiable person or a well-known named character (the same figures in character_bible), every concept's image_prompt MUST name that subject explicitly by their proper name — the same principle as the title naming its real subject, not a generic lookalike. Only fall back to a generic figure when the Short genuinely has no single identifiable person or character at its center. No text in the image itself (the app renders the overlay_text separately).`;

    const context = `Full video this Short teases: "${parentTitle || topic}"
Topic: "${topic}"
Narrative angle of the full video: ${angle || '(infer from the title)'}
Visual style: ${style}${characterContext}`;

    const systemPrompt = `${context}\n\n${creativeOverride || SHORT_SCRIPT_DIRECTION}\n\n${SCHEMA}`;

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          // 6000 (was 5000): now that 3 full thumbnail_concepts are mandatory on top of up to 10
          // scenes + character_bible, 5000 could truncate `scenes` (the last field) → the whole JSON
          // fails to parse → no Short at all. A little more headroom for the same content.
          max_tokens: 6000,
          system: systemPrompt,
          messages: [{ role: 'user', content: 'Write the complete Short script now. Respond with JSON only.' }],
        }),
      });
    } catch (err) {
      console.error('[generate-short-script] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[generate-short-script] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }
    if (!response.ok) {
      console.error('[generate-short-script] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-short-script] phase=parse-envelope-json', err?.message, 'raw=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    const rawContent = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const clean = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[generate-short-script] phase=locate-json no braces, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[generate-short-script] phase=parse-plan-json', e?.message, 'stop_reason=', data?.stop_reason, 'text=', clean.slice(0, 400));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    const scenes = Array.isArray(plan.scenes) ? plan.scenes.filter((s) => s && typeof s.narration === 'string' && s.narration.trim()) : [];
    if (scenes.length < 4) {
      console.error('[generate-short-script] phase=validate too few scenes:', scenes.length, 'stop_reason=', data?.stop_reason);
      return res.status(502).json({ error: `Short script returned only ${scenes.length} usable scenes` });
    }

    return res.status(200).json({
      title: typeof plan.title === 'string' ? plan.title.trim() : '',
      description: typeof plan.description === 'string' ? plan.description.trim() : '',
      tags: Array.isArray(plan.tags) ? plan.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 15) : [],
      thumbnail_concepts: Array.isArray(plan.thumbnail_concepts) ? plan.thumbnail_concepts.slice(0, 3) : [],
      character_bible: Array.isArray(plan.character_bible) && plan.character_bible.length ? plan.character_bible : characterBible,
      scenes: scenes.slice(0, 10),
    });
  } catch (err) {
    console.error('[generate-short-script] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

function clampToSafetyCap(plan, capMinScenes, capMaxScenes) {
  const outline = plan.outline;
  const currentTotal = outline.reduce((sum, ch) => sum + (Number(ch.scene_count) || 0), 0);
  let target = currentTotal;
  if (currentTotal > capMaxScenes) target = capMaxScenes;
  else if (currentTotal < capMinScenes) target = capMinScenes;
  if (target !== currentTotal) {
    const delta = target - currentTotal; // negative to shrink, positive to grow
    const last = outline[outline.length - 1];
    last.scene_count = Math.max(1, (Number(last.scene_count) || 0) + delta);
  }
  plan.total_scenes = outline.reduce((sum, ch) => sum + (Number(ch.scene_count) || 0), 0);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[generate-outline] phase=config missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Stage 1 (titles) is dispatched here, before any of the outline-specific body validation below.
  if (req.body?.mode === 'titles') return generateTitles(req, res, apiKey);
  // Companion-Short script (src/lib/shortsEngine.js) — same dispatch pattern, folded in to stay
  // under Vercel Hobby's 12-function cap.
  if (req.body?.mode === 'short-script') return generateShortScript(req, res, apiKey);

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let topic, title, angle, language, lengthMinutes, style, imageProvider, hints, notes, refs, totalScenes, creativeOverride;
    let aiDecidesLength, capMinMinutes, capMaxMinutes, contentType, isStaticBackground, channelIntroEnabled, niche, channelCharacters;
    try {
      const body = req.body || {};
      topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      title = typeof body.title === 'string' ? body.title.trim() : '';
      angle = typeof body.angle === 'string' ? body.angle.trim() : '';
      if (!topic || topic.length > 500) return res.status(400).json({ error: 'Invalid topic' });
      if (!title) return res.status(400).json({ error: 'Invalid title' });

      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'facestick';
      imageProvider = ['pollinations', 'nanobanana', 'gptimage'].includes(body.imageProvider) ? body.imageProvider : 'pollinations';
      // 'static_background' (language-learning script, no per-scene images) vs. the default
      // image-driven pipeline — see CreateStep.jsx/AutomationStep.jsx's "Content type" select.
      // Script-generation-only for now: this changes narration pacing/schema below, nothing else.
      contentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
      isStaticBackground = contentType === 'static_background';

      aiDecidesLength = body.aiDecidesLength === true;
      if (aiDecidesLength) {
        // Both bounds required together — a lone min or max isn't a coherent boundary, so treat it
        // as "no cap" rather than guessing what the missing side should be.
        const min = Number(body.capMinMinutes);
        const max = Number(body.capMaxMinutes);
        const hasCap = Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0 && max >= min;
        capMinMinutes = hasCap ? min : null;
        capMaxMinutes = hasCap ? max : null;
        lengthMinutes = null; // no fixed target in this mode — see AI_DECIDES_LENGTH_INSTRUCTION
        totalScenes = null;
      } else if (isStaticBackground) {
        // Never forced from the visual-pacing density formula (scenes/minute) — that formula
        // assumes one image cut every few seconds, meaningless for continuous spoken narration
        // over a static background. lengthMinutes is still respected as a rough target (see
        // lengthInstruction below), but the actual scene count is left for the model to decide
        // based on exactly one sentence per scene, strictly, never two (see
        // api/generate-scenes.js's own narration instruction) — same "free total_scenes"
        // mechanism as aiDecidesLength, just without dropping the length target entirely. This
        // naturally means many more, shorter scenes than a paragraph-level split would — expected
        // and correct: it's what makes the scene boundary and the sentence boundary the exact same
        // thing, so the on-screen caption/.srt cue can simply span the scene's own real duration
        // with zero internal splitting logic.
        capMinMinutes = null;
        capMaxMinutes = null;
        lengthMinutes = Number(body.lengthMinutes);
        if (!Number.isFinite(lengthMinutes) || lengthMinutes <= 0) lengthMinutes = 1;
        lengthMinutes = Math.min(25, Math.max(1, lengthMinutes));
        totalScenes = null;
      } else {
        capMinMinutes = null;
        capMaxMinutes = null;
        lengthMinutes = Number(body.lengthMinutes);
        if (!Number.isFinite(lengthMinutes) || lengthMinutes <= 0) lengthMinutes = 1;
        lengthMinutes = Math.min(25, Math.max(1, lengthMinutes));
        totalScenes = Math.max(6, Math.round(lengthMinutes * 12));
      }
      hints = Array.isArray(body.characterHints)
        ? body.characterHints
            .filter((c) => c && typeof c === 'object' && ((typeof c.name === 'string' && c.name.trim()) || (typeof c.details === 'string' && c.details.trim())))
            .map((c) => ({ name: typeof c.name === 'string' ? c.name.trim() : '', details: typeof c.details === 'string' ? c.details.trim() : '' }))
        : [];
      notes = typeof body.generalNotes === 'string' ? body.generalNotes.trim() : '';

      refs = Array.isArray(body.references)
        ? body.references
            .filter((r) => r && typeof r.label === 'string' && r.label.trim())
            .map((r) => ({ label: r.label.trim() }))
        : [];

      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';

      // Channel-level recurring characters (see src/lib/channelCharacters.js) — { id, name,
      // description, hasPhoto }. Injected into the character-bible instructions below so a figure
      // the channel keeps covering keeps the exact same id/name/look across every video.
      channelCharacters = Array.isArray(body.channelCharacters)
        ? body.channelCharacters
            .filter((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim() && typeof c.id === 'string' && c.id.trim())
            .map((c) => ({
              id: c.id.trim(),
              name: c.name.trim(),
              description: typeof c.description === 'string' ? c.description.trim() : '',
              hasPhoto: c.hasPhoto === true,
            }))
        : [];

      // Channel self-introduction (ChannelDashboardStep.jsx's "Include channel intro at video
      // start" toggle, per-video overridable from CreateStep.jsx) — only meaningful together with
      // a non-empty niche description, since that's what the welcome is built from.
      channelIntroEnabled = body.channelIntroEnabled === true;
      niche = typeof body.niche === 'string' ? body.niche.trim() : '';
    } catch (err) {
      console.error('[generate-outline] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // True whenever total_scenes is NOT a fixed, pre-computed target — either the model was asked
    // to decide the whole length itself, or this content type never uses the visual-pacing formula
    // in the first place. Both cases reuse the exact same "derive total_scenes from the outline's
    // own chapter sum, optionally clamp to a cap" mechanism below.
    const freeSceneCount = aiDecidesLength || isStaticBackground;

    // Nano Banana 2 / GPT Image 2 are LLM-native models with real-world knowledge of well-known
    // people and characters, unlike Pollinations' Flux/Kontext — writing exhaustive physical
    // descriptions for a recognizable figure is redundant at best and can actively fight what the
    // model would otherwise render correctly from the name alone. A technical fact about the
    // chosen image provider, not a stylistic choice — always included regardless of creativeOverride.
    // Irrelevant for static_background: there are no per-scene images to write prompts for at all.
    const providerAwareCharacterNote = imageProvider !== 'pollinations' && !isStaticBackground
      ? `

The image model has strong built-in world knowledge and will recognize well-known real people and iconic fictional characters by name alone — do NOT write exhaustive physical descriptions for them, it's redundant and may conflict with what the model already renders correctly. For these characters, keep base_description minimal or empty, and use variants ONLY to pin down story-specific appearance choices the model wouldn't automatically infer — which specific life stage/era to depict, a specific costume or prop relevant to that scene. For invented/fictional characters with no public recognition (i.e. not portrayed by any known actor or widely depicted), still write a full base_description as before — there's nothing for the model to already know.`
      : '';

    const referenceContext = refs.length
      ? `

These reference photos will be available when illustrating individual scenes later, each with a label describing who/what it depicts:
${refs.map((r) => `- label: "${r.label}"`).join('\n')}
Keep the character_bible consistent with these — if a reference photo's label describes a character, that character's name and variants in character_bible should align with it.`
      : '';

    // Recurring characters the channel has defined once and reuses across many videos — must keep
    // the exact same id + name every time so their rendered look stays consistent. Provider-aware
    // depth mirrors providerAwareCharacterNote above. Skipped for static_background (no per-scene
    // images, so no character rendering to keep consistent).
    const channelCharacterContext = channelCharacters.length && !isStaticBackground
      ? `

RECURRING CHANNEL CHARACTERS — these characters already exist on this channel and recur across many of its videos. Whenever one of them genuinely appears in THIS video's story, you MUST include it in character_bible using the EXACT id and name given here — never invent a new id, never rename it — so its look stays identical from video to video:
${channelCharacters.map((c) => `- id: "${c.id}", name: "${c.name}"${c.description ? ` — ${c.description}` : ''}${c.hasPhoto ? ' [reference photo available]' : ''}`).join('\n')}
${
  imageProvider !== 'pollinations'
    ? 'For any of the above the image model already recognizes by name, keep base_description minimal or empty; use variants only for story-specific era/costume choices.'
    : "Copy each description given above into that character's base_description in full — the image model has no built-in knowledge of them and needs the physical description every time."
}
Characters this video needs that are NOT in the list above are still fine — give them their own fresh ids that don't collide with these.`
      : '';

    // Length guidance — a fixed target (lengthMinutes), the fully content-driven instruction, or
    // (static_background) a target duration expressed as natural narration rather than a scene
    // count — optionally bounded by a safety cap (see AutomationStep.jsx's "Enable safety cap",
    // aiDecidesLength only). The cap sentence is appended to the AI-decides instruction itself, not
    // treated as a separate rule, so it reads as a boundary on the same judgment call rather than a
    // competing directive.
    const lengthInstruction = aiDecidesLength
      ? `${AI_DECIDES_LENGTH_INSTRUCTION}${
          capMinMinutes != null
            ? ` The total scene count across all chapters must correspond to between ${capMinMinutes} and ${capMaxMinutes} minutes (using ~12 scenes/minute as reference), regardless of the above — work within this boundary.`
            : ''
        }`
      : isStaticBackground
        ? `Video length: ~${lengthMinutes} minutes of natural spoken narration. Divide it into as many scenes as feels natural for the content — exactly ONE complete sentence per scene, never two, never a whole paragraph — rather than targeting any specific scene count or a visual-cut pacing density. This will naturally mean more, shorter scenes than a chapter-level split.`
        : `Video length: ~${lengthMinutes} minutes — split into a sensible number of chapters, roughly one chapter every 1.5-2 minutes.`;

    // The visual-art-style paragraph below only makes sense when there are actual images to draw —
    // skipped entirely for static_background, which has no per-scene images at all.
    const styleTranslationNote = isStaticBackground
      ? ''
      : `\n\nCRITICAL: character descriptions must be expressed in traits that survive translation into the chosen art style (${style}). For highly stylized styles like stick figures: use ONLY features a stick figure can carry — hair shape/color, facial hair, glasses, hats, iconic clothing items or accessories, relative height/build. NEVER use realistic facial anatomy terms (jawline, cheekbones, deep-set eyes) for stylized styles — they force the image model out of the style. For realistic styles (watercolor, comic), facial traits are allowed.`;

    // Channel self-introduction (ChannelDashboardStep.jsx's "Include channel intro at video start"
    // toggle) — only fires with a non-empty niche, since that's the raw material the welcome is
    // built from. Targets the first chapter specifically (the outline's own HOOK chapter, per the
    // creative direction above), asking it to open with the welcome before the hook itself — a fact
    // about this specific video, so it's injected into `context`, always included regardless of
    // which creative direction (default or a channel's override) is active.
    const channelIntroNote = channelIntroEnabled && niche
      ? `\n\nFor the first chapter: before diving into the story's hook, open with a brief, warm welcome (2-3 sentences) that identifies what this channel does, based on this description: "${niche}". Weave this naturally into the opening — it should feel like a genuine, friendly introduction, not a boilerplate disclaimer. If the niche description implies a language-learning purpose, frame it naturally (e.g. "told in clear, natural English so you can enjoy the story while practicing your listening"). Then transition smoothly into the hook.`
      : '';

    // Facts about THIS specific video (title, angle, length, visual style) — always injected
    // regardless of which creative direction is active (default or a channel's override), since an
    // override changes HOW to write, never WHAT video this is.
    const context = `Video title: "${title}"
Narrative angle: ${angle || '(none specified — infer a coherent angle from the title itself)'}
${lengthInstruction}${styleTranslationNote}${channelIntroNote}`;

    // total_scenes is either the fixed target (forced onto the response later regardless of what
    // the model returns) or, whenever freeSceneCount is true, whatever the model itself determines
    // — the schema documentation and rule below reflect that difference explicitly rather than
    // showing a number that doesn't apply.
    const totalScenesSchemaValue = freeSceneCount ? 'number (however many scenes you determine this video genuinely needs)' : totalScenes;
    const totalScenesRule = freeSceneCount
      ? `The sum of every chapter's scene_count MUST equal exactly the total_scenes value you provide.`
      : `The sum of every chapter's scene_count MUST equal exactly ${totalScenes}.`;

    // The output-format half — field names, types, and hard correctness rules that downstream
    // parsing (client) and the next pipeline stage (api/generate-scenes.js, which references these
    // exact character/chapter ids) depend on. NEVER influenced by creativeOverride, in any case.
    const SCHEMA_INSTRUCTIONS = `You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "description": "SEO-optimized YouTube description, 3-5 sentences, includes a hook line and 3 relevant hashtags at the end, written to match the chosen angle",
  "tags": [15 short SEO tag strings],
  "thumbnail_concepts": [3 objects: { "overlay_text": "punchy text max 4 words UPPERCASE", "image_prompt": "concrete visual description in English for an AI image generator: one strong focal subject, exaggerated emotion, no text in image. If a real, identifiable person or a well-known named character is central to this video, that focal subject MUST be named explicitly by their proper name (e.g. \\"Elon Musk with a shocked expression, plunging red stock-market graphs behind him\\") — never a generic stand-in like \\"a businessman\\" or \\"a shocked man\\"" }],
  "character_bible": [array of objects, one per recurring character: { "id": string, "name": string, "base_description": "distinctive traits that NEVER change: face shape, build, defining features — max 12-15 words, telegraphic comma-separated fragments, NOT a full sentence", "variants": [{ "label": "e.g. Young Napoleon, 1790s", "description": "traits specific to this era/stage: hair, clothing, age markers — max 12-15 words, telegraphic comma-separated fragments, NOT a full sentence" }] }],
  "outline": [array of chapter objects: { "id": string, "title": "chapter name", "summary": "2-3 sentences on what happens in this chapter and how it connects to the previous/next one", "scene_count": number }],
  "total_scenes": ${totalScenesSchemaValue}
}

Rules:
- ${totalScenesRule}
- thumbnail_concepts: when this video centers on a real, identifiable person or a well-known named character (the same figures you are listing in character_bible), every concept's image_prompt MUST name that subject explicitly by their proper name — exactly the same principle as the title naming its real subject, not a generic lookalike description. Only fall back to a generic figure when the video genuinely has no single identifiable person or character at its center.
- Give each chapter a short, stable "id" (e.g. "ch1_hook", lowercase, no spaces).
- Assign each character a stable "id" (e.g. "char_napoleon", lowercase, no spaces) — later calls that write individual scenes will reference these same ids, so keep them short and consistent.${providerAwareCharacterNote}${referenceContext}${channelCharacterContext}`;

    const defaultCreativeDirection = isStaticBackground ? DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND : DEFAULT_CREATIVE_DIRECTION;
    const systemPrompt = `${context}\n\n${creativeOverride || defaultCreativeDirection}\n\n${SCHEMA_INSTRUCTIONS}`;

    const userLengthLine = aiDecidesLength
      ? `Video length: let it emerge naturally from how much content this topic genuinely supports — do not target a fixed number of scenes.${
          capMinMinutes != null ? ` Stay within ${capMinMinutes}-${capMaxMinutes} minutes (~${capMinMinutes * 12}-${capMaxMinutes * 12} scenes).` : ''
        }`
      : isStaticBackground
        ? `Video length: ~${lengthMinutes} minutes of natural spoken narration — let the number of scenes emerge from natural sentence-level divisions (exactly one sentence per scene, never two, never a whole paragraph), not a fixed scene-count target.`
        : `Video length: ~${lengthMinutes} minutes (${totalScenes} scenes total)`;

    const userLines = [
      `Topic: "${topic}"`,
      userLengthLine,
      `Visual style of the channel: ${style}`,
      hints.length
        ? `Known characters (use these details, prioritize them over your own assumptions):\n${hints
            .map((h) => `- ${h.name || 'Unnamed character'}: ${h.details || '(no physical details given — infer if well-known, otherwise use your judgment)'}`)
            .join('\n')}`
        : '',
      notes ? `General notes on tone, setting and recurring elements: ${notes}` : '',
      'Respond with JSON only.',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Phase 2: call Anthropic.
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 6000,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: userLines }],
        }),
      });
    } catch (err) {
      console.error('[generate-outline] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[generate-outline] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[generate-outline] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    // Phase 4: parse the outer envelope JSON in its own try/catch — a 200 isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-outline] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    // Phase 5: pull out the model's text blocks — web_search tool_use/tool_result blocks are
    // interleaved in data.content but are a different block type, so this filter already skips them.
    let raw;
    try {
      raw = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    } catch (err) {
      console.error('[generate-outline] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[generate-outline] phase=locate-json no braces found, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    // Phase 6: parse the model's actual JSON payload.
    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[generate-outline] phase=parse-plan-json', e?.message, 'raw text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.outline) || plan.outline.length === 0) {
      console.error('[generate-outline] phase=validate-plan missing/empty outline, plan=', JSON.stringify(plan).slice(0, 300));
      return res.status(502).json({ error: 'AI response missing outline' });
    }

    if (freeSceneCount) {
      // Derived from what the model actually returned (the chapters are the real driver for
      // api/generate-scenes.js downstream) rather than trusted from the model's own top-level
      // total_scenes field, which could drift from the chapter sum. capMinMinutes/capMaxMinutes are
      // only ever set when aiDecidesLength is the reason freeSceneCount is true (static_background
      // has no cap mechanism), so this clamp naturally never fires for static_background.
      plan.total_scenes = plan.outline.reduce((sum, ch) => sum + (Number(ch.scene_count) || 0), 0);
      if (capMinMinutes != null && capMaxMinutes != null) {
        const capMinScenes = Math.max(1, Math.round(capMinMinutes * 12));
        const capMaxScenes = Math.max(capMinScenes, Math.round(capMaxMinutes * 12));
        clampToSafetyCap(plan, capMinScenes, capMaxScenes);
      }
    } else {
      plan.total_scenes = totalScenes;
    }
    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-outline] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
