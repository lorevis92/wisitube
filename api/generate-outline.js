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

      lengthMinutes = Number(body.lengthMinutes);
      if (!Number.isFinite(lengthMinutes) || lengthMinutes <= 0) lengthMinutes = 1;
      lengthMinutes = Math.min(25, Math.max(1, lengthMinutes));
      totalScenes = Math.max(6, Math.round(lengthMinutes * 12));

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

    // Nano Banana 2 / GPT Image 2 are LLM-native models with real-world knowledge of well-known
    // people and characters, unlike Pollinations' Flux/Kontext — writing exhaustive physical
    // descriptions for a recognizable figure is redundant at best and can actively fight what the
    // model would otherwise render correctly from the name alone. A technical fact about the
    // chosen image provider, not a stylistic choice — always included regardless of creativeOverride.
    const providerAwareCharacterNote = imageProvider !== 'pollinations'
      ? `

The image model has strong built-in world knowledge and will recognize well-known real people and iconic fictional characters by name alone — do NOT write exhaustive physical descriptions for them, it's redundant and may conflict with what the model already renders correctly. For these characters, keep base_description minimal or empty, and use variants ONLY to pin down story-specific appearance choices the model wouldn't automatically infer — which specific life stage/era to depict, a specific costume or prop relevant to that scene. For invented/fictional characters with no public recognition (i.e. not portrayed by any known actor or widely depicted), still write a full base_description as before — there's nothing for the model to already know.`
      : '';

    const referenceContext = refs.length
      ? `

These reference photos will be available when illustrating individual scenes later, each with a label describing who/what it depicts:
${refs.map((r) => `- label: "${r.label}"`).join('\n')}
Keep the character_bible consistent with these — if a reference photo's label describes a character, that character's name and variants in character_bible should align with it.`
      : '';

    // Facts about THIS specific video (title, angle, length, visual style) — always injected
    // regardless of which creative direction is active (default or a channel's override), since an
    // override changes HOW to write, never WHAT video this is.
    const context = `Video title: "${title}"
Narrative angle: ${angle || '(none specified — infer a coherent angle from the title itself)'}
Video length: ~${lengthMinutes} minutes — split into a sensible number of chapters, roughly one chapter every 1.5-2 minutes.

CRITICAL: character descriptions must be expressed in traits that survive translation into the chosen art style (${style}). For highly stylized styles like stick figures: use ONLY features a stick figure can carry — hair shape/color, facial hair, glasses, hats, iconic clothing items or accessories, relative height/build. NEVER use realistic facial anatomy terms (jawline, cheekbones, deep-set eyes) for stylized styles — they force the image model out of the style. For realistic styles (watercolor, comic), facial traits are allowed.`;

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
  "total_scenes": ${totalScenes}
}

Rules:
- The sum of every chapter's scene_count MUST equal exactly ${totalScenes}.
- Give each chapter a short, stable "id" (e.g. "ch1_hook", lowercase, no spaces).
- Assign each character a stable "id" (e.g. "char_napoleon", lowercase, no spaces) — later calls that write individual scenes will reference these same ids, so keep them short and consistent.${providerAwareCharacterNote}${referenceContext}`;

    const systemPrompt = `${context}\n\n${creativeOverride || DEFAULT_CREATIVE_DIRECTION}\n\n${SCHEMA_INSTRUCTIONS}`;

    const userLines = [
      `Topic: "${topic}"`,
      `Video length: ~${lengthMinutes} minutes (${totalScenes} scenes total)`,
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

    plan.total_scenes = totalScenes;
    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-outline] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
