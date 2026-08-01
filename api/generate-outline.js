// WisiTube — Outline generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Second stage of the titles → outline → scenes pipeline. Runs AFTER the user has picked a title
// and its narrative angle (api/generate-titles.js) — everything here is anchored to that specific
// angle, not a generic treatment of the topic. Produces the SEO pack, the character bible (with
// web search enabled, same as the old single-call api/generate.js), and a chapter outline whose
// scene_count fields the client will later split into individual api/generate-scenes.js calls.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 120 };

// The "channel voice" half of the system prompt — tone, editorial priorities, how to approach
// outline pacing and character-bible writing. Safe to override per-channel (see creativeOverride
// below): no required JSON field name or hard correctness rule lives here, only guidance on how to
// write. Deliberately has no per-request interpolation (title/angle/length/style) — those are
// facts about this specific video, not stylistic choices, so they're always injected separately
// (see the `context` constant below) regardless of whether this default or a channel's override is active.
const DEFAULT_CREATIVE_DIRECTION = `You are a YouTube strategist and scriptwriter for successful faceless animated channels.

Everything you produce must be built AROUND the video's specific narrative angle, not a generic treatment of the topic. Structure the outline so each chapter has a clear role in the narrative arc: the first chapter is the HOOK (open with the angle's most surprising fact or question), middle chapters develop and escalate the angle, the last chapter is the climax and closes with a call to action (subscribe / watch next). Every chapter must build on the last, staying anchored to the chosen angle throughout — never drift into a generic retelling of the topic.

For the character bible: identify every character that appears in more than one scene across the ENTIRE video — including the narrator/protagonist even if not explicitly named by the user. If the user provided character hints, prioritize those details over your own assumptions. Create at least 2 variants when the story spans different life stages, time periods, or notable appearance changes (e.g. young vs old, before/after a transformation) — otherwise a single variant is enough. Every variant must preserve the base_description's core identifying traits while adapting era-specific details, so the character stays recognizable across variants.

For every real, named, identifiable person in the character_bible (historical figures, celebrities, public figures) — search the web to verify their actual physical appearance before writing descriptions. Identify which traits are constant identity anchors that persist across their entire life (bone structure, ear shape, distinctive permanent marks, eye shape/color, general build proportions) versus which traits change by era (hair length/color/style, facial hair, weight, clothing, age-related features). The base_description must contain only the constant anchors. Each variant's description must contain only the era-specific changes — never repeat the constant anchors in variants, they're inherited automatically. For fictional characters or figures the search doesn't surface reliable information about, fall back on your own knowledge or reasonable invention guided by any user-provided character hints. Keep base_description and every variant description short and telegraphic — max 12-15 words each, comma-separated traits, never a full discursive sentence — since these get concatenated directly into image-generation prompts and must stay lean.`;

// Same "channel voice" role as DEFAULT_CREATIVE_DIRECTION above, for content_type
// 'static_background' — no per-scene images exist in this mode, so the character-bible guidance
// (and the narrative-arc guidance generally) drops every mention of visual appearance/art style,
// keeping character_bible purely as a naming/identity aid for consistent narration.
const DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND = `You are a scriptwriter for spoken-narration, language-learning videos with a static background — there is no per-scene visual component, only continuous narration meant to be listened to and read along.

Everything you produce must be built AROUND the video's specific narrative angle, not a generic treatment of the topic. Structure the outline so each chapter has a clear role in the narrative arc: the first chapter is the HOOK, middle chapters develop and escalate the angle, the last chapter is the climax and closes with a call to action (subscribe / watch next). Every chapter must build on the last, staying anchored to the chosen angle throughout — never drift into a generic retelling of the topic.

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

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let topic, title, angle, language, lengthMinutes, style, imageProvider, hints, notes, refs, totalScenes, creativeOverride;
    let aiDecidesLength, capMinMinutes, capMaxMinutes, contentType, isStaticBackground;
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
        // based on natural sentence-level divisions (one sentence per scene, not a whole
        // paragraph — see api/generate-scenes.js's own narration instruction) — same "free
        // total_scenes" mechanism as aiDecidesLength, just without dropping the length target
        // entirely. This naturally means many more, shorter scenes than a paragraph-level split
        // would — expected and correct: it's what keeps each scene's real audio duration short
        // enough for its on-screen caption/.srt cue to stay in sync without needing sub-chunking.
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
        ? `Video length: ~${lengthMinutes} minutes of natural spoken narration. Divide it into as many scenes as feels natural for the content — roughly one complete sentence (occasionally two short related sentences) per scene, never a whole paragraph — rather than targeting any specific scene count or a visual-cut pacing density. This will naturally mean more, shorter scenes than a chapter-level split.`
        : `Video length: ~${lengthMinutes} minutes — split into a sensible number of chapters, roughly one chapter every 1.5-2 minutes.`;

    // The visual-art-style paragraph below only makes sense when there are actual images to draw —
    // skipped entirely for static_background, which has no per-scene images at all.
    const styleTranslationNote = isStaticBackground
      ? ''
      : `\n\nCRITICAL: character descriptions must be expressed in traits that survive translation into the chosen art style (${style}). For highly stylized styles like stick figures: use ONLY features a stick figure can carry — hair shape/color, facial hair, glasses, hats, iconic clothing items or accessories, relative height/build. NEVER use realistic facial anatomy terms (jawline, cheekbones, deep-set eyes) for stylized styles — they force the image model out of the style. For realistic styles (watercolor, comic), facial traits are allowed.`;

    // Facts about THIS specific video (title, angle, length, visual style) — always injected
    // regardless of which creative direction is active (default or a channel's override), since an
    // override changes HOW to write, never WHAT video this is.
    const context = `Video title: "${title}"
Narrative angle: ${angle || '(none specified — infer a coherent angle from the title itself)'}
${lengthInstruction}${styleTranslationNote}`;

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
  "thumbnail_concepts": [3 objects: { "overlay_text": "punchy text max 4 words UPPERCASE", "image_prompt": "concrete visual description in English for an AI image generator, one strong focal subject, exaggerated emotion, no text in image" }],
  "character_bible": [array of objects, one per recurring character: { "id": string, "name": string, "base_description": "distinctive traits that NEVER change: face shape, build, defining features — max 12-15 words, telegraphic comma-separated fragments, NOT a full sentence", "variants": [{ "label": "e.g. Young Napoleon, 1790s", "description": "traits specific to this era/stage: hair, clothing, age markers — max 12-15 words, telegraphic comma-separated fragments, NOT a full sentence" }] }],
  "outline": [array of chapter objects: { "id": string, "title": "chapter name", "summary": "2-3 sentences on what happens in this chapter and how it connects to the previous/next one", "scene_count": number }],
  "total_scenes": ${totalScenesSchemaValue}
}

Rules:
- ${totalScenesRule}
- Give each chapter a short, stable "id" (e.g. "ch1_hook", lowercase, no spaces).
- Assign each character a stable "id" (e.g. "char_napoleon", lowercase, no spaces) — later calls that write individual scenes will reference these same ids, so keep them short and consistent.${providerAwareCharacterNote}${referenceContext}`;

    const defaultCreativeDirection = isStaticBackground ? DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND : DEFAULT_CREATIVE_DIRECTION;
    const systemPrompt = `${context}\n\n${creativeOverride || defaultCreativeDirection}\n\n${SCHEMA_INSTRUCTIONS}`;

    const userLengthLine = aiDecidesLength
      ? `Video length: let it emerge naturally from how much content this topic genuinely supports — do not target a fixed number of scenes.${
          capMinMinutes != null ? ` Stay within ${capMinMinutes}-${capMaxMinutes} minutes (~${capMinMinutes * 12}-${capMaxMinutes * 12} scenes).` : ''
        }`
      : isStaticBackground
        ? `Video length: ~${lengthMinutes} minutes of natural spoken narration — let the number of scenes emerge from natural sentence-level divisions (one sentence, occasionally two short related ones, per scene — never a whole paragraph), not a fixed scene-count target.`
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
