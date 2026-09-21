// WisiTube — Scene chunk generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Third and final stage of the titles → outline → scenes pipeline. Writes one chunk of scenes
// (up to 16) for a single chapter of the video's outline. A chapter with more scenes than that is
// split into multiple calls by the client, each one told how it connects to the previous chunk via
// previousTail so the narration reads as one continuous voiceover, not disjointed fragments.
//
// No web search here — character research already happened once in api/generate-outline.js; this
// endpoint only writes narration + image beats against the character bible it was handed.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

// 120s (up from 90): with max_tokens raised to 8000 a full 16-scene chunk can legitimately take
// longer to generate — don't let the fix for truncation trade itself for a platform 504.
export const config = { maxDuration: 120 };

// The "channel voice" half of the system prompt — narration tone and shot-writing style. Safe to
// override per-channel (see creativeOverride below): no required JSON field name or hard
// correctness rule lives here. No per-request interpolation on purpose — video-specific facts
// (title, topic, chapter continuity) are always injected separately (see the `context` constant
// below) regardless of whether this default or a channel's override is active.
const DEFAULT_CREATIVE_DIRECTION = `You are a YouTube scriptwriter continuing a faceless animated video already in progress.

Narration must flow naturally when read aloud in sequence, conversational tone, no scene numbers. Vary the animations; never use the same one twice in a row within a scene, and avoid repeating the same animation across consecutive scenes. Each scene's two image_beats must be visually distinct from each other — a different subject, moment, or camera framing that both illustrate the same narration from two angles. Never make the two beats the same image concept restated.`;

// Same "channel voice" role as DEFAULT_CREATIVE_DIRECTION above, for content_type
// 'static_background' — no image_beats exist in this mode, so every instruction about animations,
// shots or visual distinctness is dropped; only narration pacing/continuity remains.
const DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND = `You are continuing the script for a spoken-narration, language-learning video with a static background already in progress — there is no visual component to write for, only continuous narration.

Narration must flow naturally when read aloud in sequence, calm and measured conversational tone, no scene numbers, no visual cues or stage directions of any kind.`;

// DIAGNOSTIC (not a fix): when the model's JSON can't be parsed/validated, dump everything needed
// to tell truncation from malformed output from a masked API error — the FULL raw text (Vercel
// truncates a single console line, so it's split into ~3 KB chunks), plus Anthropic's own
// stop_reason / usage, which say outright when a response was cut off at max_tokens.
function dumpUnparsableSceneResponse(tag, { anthropicData, rawText, cleanText, chapterTitle, sceneCount, parseError }) {
  try {
    const raw = typeof rawText === 'string' ? rawText : '';
    const clean = typeof cleanText === 'string' ? cleanText : '';
    console.error(
      `[generate-scenes] DIAGNOSTIC ${tag} — chapter="${chapterTitle}" sceneCount=${sceneCount} ` +
        `stop_reason=${anthropicData?.stop_reason} ` +
        `output_tokens=${anthropicData?.usage?.output_tokens} input_tokens=${anthropicData?.usage?.input_tokens} ` +
        `rawLen=${raw.length} cleanLen=${clean.length} ` +
        `parseError=${parseError ? String(parseError.message || parseError) : 'n/a'}`
    );
    const src = clean || raw;
    const CHUNK = 3000;
    const total = Math.ceil(src.length / CHUNK) || 1;
    for (let i = 0; i < total; i++) {
      console.error(`[generate-scenes] DIAGNOSTIC ${tag} rawtext part ${i + 1}/${total}:\n` + src.slice(i * CHUNK, (i + 1) * CHUNK));
    }
  } catch (e) {
    console.error('[generate-scenes] DIAGNOSTIC dump itself failed', e?.message);
  }
}

// ---- mode: 'repetition-audit' ----
// One-shot editorial pass over a FULLY-written script, run once (client side: src/lib/repetitionAudit.js)
// after every scene exists and before any media is generated. Folded in here as a mode dispatch
// rather than its own file to stay under Vercel Hobby's function cap (same reason as
// generate-outline.js's 'titles' / 'short-script' modes). The exact system prompt is fixed by
// product spec — do not paraphrase it.
const REPETITION_AUDIT_SYSTEM = `You are the senior editor performing the final repetition audit of a YouTube script.
Review the complete script paragraph by paragraph.
Identify:
- facts stated more than once;
- conclusions repeated in different words;
- redundant summaries;
- sections with overlapping purposes;
- repeated rhetorical questions, metaphors, transitions, or distinctive phrases;
- paragraphs that add no new information;
- callbacks that repeat rather than deepen an earlier point.

For each scene, decide one of three actions:
- "keep": scene is fine as-is, optionally with minor edited narration text
- "delete": scene is fully redundant, remove entirely
- "merge": scene overlaps with another scene — combine into one, specify which scene id absorbs it and provide the new combined narration

Editing rules:
- Preserve the strongest and clearest version of each idea.
- When a later passage genuinely deepens an earlier idea, introduce it as an intentional callback and make the new layer explicit (e.g. signal "let's go deeper into X" rather than silently repeating it).
- Replace empty repetition with specific facts, mechanisms, consequences, examples, or analysis only when supported by the existing script — never invent new facts.
- Preserve narrative voice and factual meaning.
- Prefer a shorter, stronger final script over one padded to reach any particular length.

Every surviving scene must contribute something the audience did not already know, or change how they understand something they already know.

Return a JSON array, one entry per original scene id, each with: {"id": ..., "action": "keep"|"delete"|"merge", "narration": "..." (if keep/merge), "mergeInto": id (if merge)}.`;

function dumpUnparsableAuditResponse(tag, { anthropicData, text, sceneCount, parseError }) {
  try {
    const src = typeof text === 'string' ? text : '';
    console.error(
      `[repetition-audit] DIAGNOSTIC ${tag} — sceneCount=${sceneCount} ` +
        `stop_reason=${anthropicData?.stop_reason} output_tokens=${anthropicData?.usage?.output_tokens} ` +
        `input_tokens=${anthropicData?.usage?.input_tokens} len=${src.length} ` +
        `parseError=${parseError ? String(parseError.message || parseError) : 'n/a'}`
    );
    const CHUNK = 3000;
    const total = Math.ceil(src.length / CHUNK) || 1;
    for (let i = 0; i < total; i++) {
      console.error(`[repetition-audit] DIAGNOSTIC ${tag} rawtext part ${i + 1}/${total}:\n` + src.slice(i * CHUNK, (i + 1) * CHUNK));
    }
  } catch (e) {
    console.error('[repetition-audit] DIAGNOSTIC dump itself failed', e?.message);
  }
}

async function repetitionAudit(req, res, apiKey) {
  try {
    let scenes, title, language;
    try {
      const body = req.body || {};
      scenes = Array.isArray(body.scenes)
        ? body.scenes
            .filter(
              (s) =>
                s &&
                typeof s === 'object' &&
                (typeof s.sceneId === 'number' || typeof s.sceneId === 'string') &&
                typeof s.narration === 'string'
            )
            .map((s) => ({ sceneId: s.sceneId, narration: s.narration.trim() }))
        : [];
      if (scenes.length < 2) return res.status(400).json({ error: 'Need at least 2 scenes to audit' });
      title = typeof body.title === 'string' ? body.title.trim() : '';
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
    } catch (err) {
      console.error('[repetition-audit] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const sceneCount = scenes.length;
    // Same margin logic as the generate-scenes max_tokens fix (a 16-scene chunk needed 8000 ≈
    // 500/scene). Here the model emits one small entry per scene — id + action, plus (for keep/merge)
    // a narration up to ~200 chars — so ~350/scene over a 2000 base is generous, capped so a
    // pathologically long script can't blow past the model's own output ceiling.
    const maxTokens = Math.min(24000, 2000 + sceneCount * 350);

    const scriptBlock = scenes.map((s) => `[scene id ${s.sceneId}]\n${s.narration}`).join('\n\n');
    const idList = scenes.map((s) => s.sceneId).join(', ');
    const systemPrompt = `${REPETITION_AUDIT_SYSTEM}

The script below has ${sceneCount} scenes with these ids, in order: ${idList}.
Your JSON array MUST contain EXACTLY one entry per id above (${sceneCount} entries), using those exact ids. Raw JSON array only — no markdown, no backticks, no preamble.`;

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: `Video title: "${title}"
Narration language: ${language}

Complete assembled script, scene by scene:

${scriptBlock}

Perform the repetition audit and return the JSON array now.`,
            },
          ],
        }),
      });
    } catch (err) {
      console.error('[repetition-audit] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[repetition-audit] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }
    if (!response.ok) {
      console.error('[repetition-audit] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[repetition-audit] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    const modelText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (data?.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn(
        `[repetition-audit] DIAGNOSTIC stop_reason=${data.stop_reason} output_tokens=${data?.usage?.output_tokens} ` +
          `sceneCount=${sceneCount} maxTokens=${maxTokens} — response may be truncated`
      );
    }

    const clean = modelText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start === -1 || end === -1) {
      dumpUnparsableAuditResponse('locate-json', { anthropicData: data, text: clean || modelText, sceneCount });
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    let actions;
    try {
      actions = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      dumpUnparsableAuditResponse('parse-json', { anthropicData: data, text: clean, sceneCount, parseError: e });
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(actions) || actions.length === 0) {
      dumpUnparsableAuditResponse('validate-not-array', { anthropicData: data, text: clean, sceneCount });
      return res.status(502).json({ error: 'AI response was not a JSON array' });
    }

    // Keep only well-formed entries; the client tolerates missing ids (treats them as "keep").
    const cleaned = actions
      .filter((a) => a && typeof a === 'object' && (typeof a.id === 'number' || typeof a.id === 'string'))
      .map((a) => ({
        id: a.id,
        action: ['keep', 'delete', 'merge'].includes(a.action) ? a.action : 'keep',
        narration: typeof a.narration === 'string' ? a.narration : undefined,
        mergeInto: typeof a.mergeInto === 'number' || typeof a.mergeInto === 'string' ? a.mergeInto : undefined,
      }));

    return res.status(200).json({ actions: cleaned });
  } catch (err) {
    console.error('[repetition-audit] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

// Shared by the default (outline-driven) scene-chunk handler below and splitScriptBeats (the
// "paste your own script" mode further down) — both hand the model a character_bible and must
// validate it the exact same way, since both feed the exact same character_id/variant_label
// assignment rules downstream.
function parseCharacterBibleForBeats(raw) {
  return Array.isArray(raw)
    ? raw
        .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id)
        .map((c) => ({
          id: c.id,
          name: typeof c.name === 'string' ? c.name : '',
          variants: Array.isArray(c.variants) ? c.variants.filter((v) => v && typeof v.label === 'string').map((v) => v.label) : [],
        }))
    : [];
}

// Shared by the default scene-chunk handler and splitScriptBeats — same reasoning as
// parseCharacterBibleForBeats above, for reference photos instead of characters.
function parseReferencesForBeats(raw) {
  return Array.isArray(raw)
    ? raw.filter((r) => r && typeof r.id === 'string' && typeof r.label === 'string' && r.label.trim()).map((r) => ({ id: r.id, label: r.label.trim() }))
    : [];
}

// Shared by the default scene-chunk handler and splitScriptBeats. Both sections are entirely about
// assigning a reference photo / character appearance to an image_beat — the caller is responsible
// for only calling these when the content type actually has image_beats at all (static_background
// never does). Returns '' when there's nothing to offer, so a caller can always splice the result
// straight into its own template string.
function buildReferenceSection(refs) {
  if (!refs.length) return '';
  return `

You have been given these reference photos, each with a label describing who/what they depict and in what context:
${refs.map((r) => `- id: "${r.id}", label: "${r.label}"`).join('\n')}

For EVERY image beat where the main subject (the person these references depict) is visibly present — as the focal subject, in the background, or partially visible — you MUST set reference_id to the id of the reference whose label best matches that beat's time period, appearance, or context. Do NOT leave reference_id null just because no label is a perfect match: if multiple references exist for the same subject, pick the closest match by context rather than skipping. Only set reference_id to null when the subject is genuinely NOT depicted in that specific beat. When in doubt, default to using the reference photo rather than skipping it.

When reference_id is set, image_prompt MUST be an editing instruction, never a fresh description that ignores the photo: state explicitly to keep the subject's face, hairstyle and distinctive features from the reference photo, and describe ONLY what changes — in the exact form "keep the subject's face, hairstyle and distinctive features from the reference photo; change only: [scene/setting/action]". When reference_id is null, image_prompt works exactly as before (plain descriptive text-to-image).`;
}

function buildCharacterAssignmentSection(characterBible) {
  if (!characterBible.length) return '';
  return `

Character bible for this video (already established — do NOT invent new characters, only ever use these exact ids):
${characterBible.map((c) => `- id: "${c.id}", name: "${c.name}"${c.variants.length ? `, variants: [${c.variants.map((l) => `"${l}"`).join(', ')}]` : ''}`).join('\n')}

For EVERY image beat where one of these characters is visibly present — as the focal subject, in the background, or partially visible — character_id and variant_label are REQUIRED: do NOT leave them null just because no variant is a perfect match, pick the closest one by that beat's narrative context. Only set character_id and variant_label to null when no character_bible character is genuinely depicted in that specific beat. If a beat has both a valid reference_id and a valid character_id for the same character, reference_id (a real photo) takes priority for the final image — character_id and variant_label are still saved as information regardless.`;
}

// Shared by the default scene-chunk handler and splitScriptBeats — same provider-aware split as
// api/generate-outline.js's own imagePromptFieldDescription.
function buildImagePromptFieldDescription(imageProvider, vertical) {
  const premiumProvider = imageProvider === 'nanobanana' || imageProvider === 'gptimage';
  return premiumProvider
    ? `concrete visual description in English of ONE clear image illustrating a specific visual moment within this narration: one subject, one action, simple composition${vertical ? ', vertical composition' : ''}. Write it as a natural sentence that explicitly names the recognizable character/person by their proper name or title (e.g. "Legolas skateboarding in streetwear", not "a blond elf with pointed ears skateboarding") — trust the model's own knowledge for their appearance. Additionally: if this beat visually represents a specific number, statistic, price, percentage, or short quote mentioned in the narration, include the EXACT text to render on-screen in quotes within the prompt (e.g. a chart labeled "+340%"), and state it must be rendered verbatim, character-for-character accurate — never approximated or altered. Only do this when on-screen text genuinely aids comprehension (data/finance/stats content), not for purely narrative/scenic beats.`
    : `concrete visual description in English of ONE clear image illustrating a specific visual moment within this narration: one subject, one action, simple composition${vertical ? ', vertical composition' : ''}. Never include text, letters, numbers or signs in the image.`;
}

// ---- mode: 'split-script' ----
//
// Alternative to the titles → outline → scenes pipeline for a video whose narration the USER writes
// themselves (CreateStep.jsx's "Paste your own script" mode), rather than one Claude invents from a
// topic. Two stages, both dispatched here (folded into this file rather than a new one, same Vercel
// Hobby function-cap reason as every other mode already in this file):
//
//   stage 'plan'  — reads the whole script ONCE and returns title/description/tags/thumbnail_concepts/
//                   character_bible (same idea as api/generate-outline.js's own outline call, just
//                   read from a finished script instead of invented from a topic) PLUS the script
//                   split into scene-sized chunks. The split must NEVER alter the wording — every
//                   returned scene must be an exact, verbatim substring of what the user wrote. The
//                   client re-verifies this in code, never trusting the instruction alone (see
//                   splitScriptIntoScenes in src/lib/sceneOrchestrator.js): it concatenates every
//                   returned scene and compares it, whitespace-insensitively, against the original
//                   script — a mismatch fails loudly instead of silently handing back altered wording.
//   stage 'beats' — writes ONLY the two image_beats for a batch of already-fixed scene narrations (up
//                   to 16 at a time, the same MAX_SCENES_PER_CALL cap the outline pipeline's own
//                   chunking uses). Narration itself is never touched here — the request doesn't even
//                   ask the model to return it, only to illustrate the exact text it's given.
//
// static_background has no per-scene images at all — the client never calls stage 'beats' for it,
// the plan stage's own scene split is already the finished result (see sceneOrchestrator.js).
const SPLIT_SCRIPT_VERBATIM_INSTRUCTION = `Do not paraphrase, summarize, shorten, or alter the wording of the provided script in any way. Your only job is to insert scene breaks at natural sentence boundaries and generate the visual image_beats for each resulting scene. The narration text of each scene must be an exact, verbatim substring of the original script — copy it character-for-character.`;

async function splitScriptPlan(req, res, apiKey) {
  try {
    let script, series, language, style, imageProvider, contentType, isStaticBackground, hints, notes, refs, channelCharacters, thumbnailCreativeDirection;
    try {
      const body = req.body || {};
      script = typeof body.script === 'string' ? body.script.trim() : '';
      // 40000 chars is a generous ceiling — a 25-minute narration (this app's longest supported
      // target) typically runs well under half that; this exists to keep the Anthropic call's
      // input/output size sane, not to constrain any realistic script.
      if (!script || script.length > 40000) return res.status(400).json({ error: 'Invalid script (must be 1-40000 characters)' });

      // Optional — same series/category context api/generate-outline.js's outline call accepts, see
      // its own comment for the full reasoning.
      series = typeof body.series === 'string' ? body.series.trim() : '';
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'facestick';
      imageProvider = ['pollinations', 'nanobanana', 'gptimage'].includes(body.imageProvider) ? body.imageProvider : 'pollinations';
      contentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
      isStaticBackground = contentType === 'static_background';

      hints = Array.isArray(body.characterHints)
        ? body.characterHints
            .filter((c) => c && typeof c === 'object' && ((typeof c.name === 'string' && c.name.trim()) || (typeof c.details === 'string' && c.details.trim())))
            .map((c) => ({ name: typeof c.name === 'string' ? c.name.trim() : '', details: typeof c.details === 'string' ? c.details.trim() : '' }))
        : [];
      notes = typeof body.generalNotes === 'string' ? body.generalNotes.trim() : '';
      refs = parseReferencesForBeats(body.references);
      thumbnailCreativeDirection = typeof body.thumbnailCreativeDirection === 'string' ? body.thumbnailCreativeDirection.trim() : '';
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
    } catch (err) {
      console.error('[split-script-plan] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const providerAwareCharacterNote = imageProvider !== 'pollinations' && !isStaticBackground
      ? `

The image model has strong built-in world knowledge and will recognize well-known real people and iconic fictional characters by name alone — do NOT write exhaustive physical descriptions for them, it's redundant and may conflict with what the model already renders correctly. For these characters, keep base_description minimal or empty, and use variants ONLY to pin down story-specific appearance choices the model wouldn't automatically infer. For invented/fictional characters with no public recognition, still write a full base_description as before.`
      : '';

    const referenceContext = refs.length
      ? `

These reference photos will be available when illustrating individual scenes later, each with a label describing who/what it depicts:
${refs.map((r) => `- label: "${r.label}"`).join('\n')}
Keep character_bible consistent with these — if a reference photo's label describes a character, that character's name and variants should align with it.`
      : '';

    const channelCharacterContext = channelCharacters.length && !isStaticBackground
      ? `

RECURRING CHANNEL CHARACTERS — these characters already exist on this channel and recur across many of its videos. Whenever one of them genuinely appears in THIS script, you MUST include it in character_bible using the EXACT id and name given here — never invent a new id, never rename it:
${channelCharacters.map((c) => `- id: "${c.id}", name: "${c.name}"${c.description ? ` — ${c.description}` : ''}${c.hasPhoto ? ' [reference photo available]' : ''}`).join('\n')}
Characters this script needs that are NOT in the list above are still fine — give them their own fresh ids that don't collide with these.`
      : '';

    const styleTranslationNote = isStaticBackground
      ? ''
      : `\n\nCRITICAL: character descriptions must be expressed in traits that survive translation into the chosen art style (${style}). For highly stylized styles like stick figures: use ONLY features a stick figure can carry — hair shape/color, facial hair, glasses, hats, iconic clothing items or accessories, relative height/build. NEVER use realistic facial anatomy terms for stylized styles.`;

    const hintsContext = hints.length
      ? `

Known characters (use these details, prioritize them over your own assumptions):
${hints.map((h) => `- ${h.name || 'Unnamed character'}: ${h.details || '(no physical details given — infer if well-known, otherwise use your judgment)'}`).join('\n')}`
      : '';

    const characterBibleInstruction = isStaticBackground
      ? `For the character bible: identify every recurring named person in the script. This exists only to keep names, roles and relationships consistent — there is no visual appearance to describe, keep base_description and variants brief and focused on identity/role/relationship, never physical traits.`
      : `For the character bible: identify every character that appears more than once across the script — including the narrator/protagonist if the script has one. Create at least 2 variants when the story spans different life stages, time periods, or notable appearance changes, otherwise a single variant is enough. For every real, named, identifiable person, use your own knowledge of their actual physical appearance. Keep base_description and every variant description short and telegraphic — max 12-15 words each, comma-separated traits, never a full sentence.${providerAwareCharacterNote}`;

    const titleInstruction = `Also write a punchy YouTube title for this video (max 70 chars) — it MUST both name the real subject explicitly by its proper name AND carry a real curiosity hook, exactly like: "Fritz Haber: The Chemist Who Fed the World, Then Gassed It" (not a vague label like "The Scientist Whose Invention Fed Billions").`;

    const densityNote = `Aim for scene lengths consistent with this app's usual pacing — roughly 7-8 scenes per minute of spoken narration as a loose reference, not a rigid rule. Never split mid-sentence; every scene break must fall at a natural sentence boundary.`;

    // Optional — same series/category context api/generate-outline.js's outline call injects, see
    // its own comment for the full reasoning.
    const seriesNote = series ? `\nSeries/category of this video: ${series}` : '';

    const systemPrompt = `You are a YouTube video producer preparing a script the user already wrote for production.${seriesNote}

${SPLIT_SCRIPT_VERBATIM_INSTRUCTION} ${densityNote}

${characterBibleInstruction}${hintsContext}${referenceContext}${channelCharacterContext}${styleTranslationNote}

${titleInstruction}

You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "title": "see instruction above",
  "description": "SEO-optimized YouTube description, 3-5 sentences, includes a hook line and 3 relevant hashtags at the end",
  "tags": [15 short SEO tag strings],
  "thumbnail_concepts": [3 objects: { "overlay_text": "punchy text, max 4 words UPPERCASE unless the channel's thumbnail creative direction below says otherwise", "image_prompt": "concrete visual description in English for an AI image generator. If a thumbnail creative direction for this channel is provided in the rules below, follow it exactly for subject, composition and tone; otherwise default to: one strong focal subject, exaggerated emotion. No text in image. If a real, identifiable person or well-known character is central, name them explicitly by proper name — never a generic stand-in.", "header_text": "optional secondary line, UPPERCASE, max 7 words; fill it ONLY if the channel's thumbnail creative direction asks for a header/secondary line, otherwise empty string" }],
  "character_bible": [array of objects: { "id": string, "name": string, "base_description": string, "variants": [{ "label": string, "description": string }] }],
  "scenes": [array of strings — the ENTIRE script split into scene-sized chunks, in original order; concatenating every entry (ignoring surrounding whitespace) must reconstruct the original script EXACTLY, word for word]
}

Rules:
- scenes MUST cover the entire script — nothing skipped, nothing added, nothing paraphrased.${
      thumbnailCreativeDirection ? `\n- Thumbnail creative direction for this channel (apply to every thumbnail_concepts entry): ${thumbnailCreativeDirection}` : ''
    }
- Assign each character a stable "id" (e.g. "char_napoleon", lowercase, no spaces).`;

    // Output ≈ the entire script echoed back (verbatim, just re-segmented) plus a modest amount of
    // metadata — sized off the script's own length rather than a fixed constant, generously (÷3
    // chars/token is conservative), capped so a pathological input can't request an absurd budget.
    const approxScriptTokens = Math.ceil(script.length / 3);
    const maxTokens = Math.min(48000, approxScriptTokens + 4000);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            { role: 'user', content: `Narration language: ${language}. Here is the complete script:\n\n${script}\n\nRespond with JSON only.` },
          ],
        }),
      });
    } catch (err) {
      console.error('[split-script-plan] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[split-script-plan] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }
    if (!response.ok) {
      console.error('[split-script-plan] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[split-script-plan] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    let raw;
    try {
      raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } catch (err) {
      console.error('[split-script-plan] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    if (data?.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn(
        `[split-script-plan] DIAGNOSTIC stop_reason=${data.stop_reason} output_tokens=${data?.usage?.output_tokens} ` +
          `scriptLen=${script.length} maxTokens=${maxTokens} — response may be truncated`
      );
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[split-script-plan] phase=locate-json no braces, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[split-script-plan] phase=parse-plan-json', e?.message, 'stop_reason=', data?.stop_reason, 'text=', clean.slice(0, 400));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      console.error('[split-script-plan] phase=validate too few scenes:', plan?.scenes?.length, 'stop_reason=', data?.stop_reason);
      return res.status(502).json({ error: 'AI response missing scenes' });
    }
    plan.scenes = plan.scenes.filter((s) => typeof s === 'string' && s.length > 0);
    if (!plan.scenes.length) return res.status(502).json({ error: 'AI response missing scenes' });

    plan.title = typeof plan.title === 'string' ? plan.title.trim() : '';
    plan.description = typeof plan.description === 'string' ? plan.description : '';
    plan.tags = Array.isArray(plan.tags) ? plan.tags : [];
    plan.thumbnail_concepts = Array.isArray(plan.thumbnail_concepts)
      ? plan.thumbnail_concepts.slice(0, 3).map((c) => ({ ...c, header_text: typeof c?.header_text === 'string' ? c.header_text.trim() : '' }))
      : [];
    plan.character_bible = Array.isArray(plan.character_bible) ? plan.character_bible : [];

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[split-script-plan] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

async function splitScriptBeats(req, res, apiKey) {
  try {
    let scenes, style, imageProvider, vertical, characterBible, refs;
    try {
      const body = req.body || {};
      scenes = Array.isArray(body.scenes) ? body.scenes.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
      if (!scenes.length || scenes.length > 16) return res.status(400).json({ error: 'Invalid scenes (must be 1-16)' });

      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'facestick';
      imageProvider = ['pollinations', 'nanobanana', 'gptimage'].includes(body.imageProvider) ? body.imageProvider : 'pollinations';
      vertical = body.format === '9:16';
      characterBible = parseCharacterBibleForBeats(body.characterBible);
      refs = parseReferencesForBeats(body.references);
    } catch (err) {
      console.error('[split-script-beats] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const imagePromptFieldDescription = buildImagePromptFieldDescription(imageProvider, vertical);
    const referenceSection = buildReferenceSection(refs);
    const characterAssignmentSection = buildCharacterAssignmentSection(characterBible);

    const sceneCount = scenes.length;
    const scenesBlock = scenes.map((s, i) => `[scene ${i + 1}] "${s}"`).join('\n\n');

    const systemPrompt = `You are illustrating scenes of a YouTube video whose narration is already final and fixed.

The narration for each scene below has ALREADY been written by someone else and must NEVER be altered, rephrased, shortened, translated, or added to in any way — your only job is to write the two image_beats for each given scene, illustrating what that exact narration describes.

Vary the animations; never use the same one twice in a row within a scene, and avoid repeating the same animation across consecutive scenes. Each scene's two image_beats must be visually distinct from each other — a different subject, moment, or camera framing that both illustrate the same narration from two angles. Never make the two beats the same image concept restated.

You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "scenes": [exactly ${sceneCount} objects, in the SAME order as the scenes listed below: {
    "image_beats": [exactly 2 objects: {
      "image_prompt": "${imagePromptFieldDescription}",
      "animation": one of "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "drift_up" | "static",
      "reference_id": string | null,
      "character_id": string | null,
      "variant_label": string | null
    }]
  }]
}

Rules:
- image_prompt must be visually literal (an image model will draw exactly this), always in English.
- If no reference photos are listed below, always set reference_id to null.${referenceSection}${characterAssignmentSection}`;

    // Lighter than the default handler's 8000/16-scene budget — this stage never authors narration
    // (the heaviest part of that budget), only 2 image_beats per scene.
    const maxTokens = Math.min(12000, 1000 + sceneCount * 500);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Write the image_beats for these ${sceneCount} scenes:\n\n${scenesBlock}\n\nRespond with JSON only.` }],
        }),
      });
    } catch (err) {
      console.error('[split-script-beats] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[split-script-beats] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }
    if (!response.ok) {
      console.error('[split-script-beats] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[split-script-beats] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    let raw;
    try {
      raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } catch (err) {
      console.error('[split-script-beats] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    if (data?.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn(
        `[split-script-beats] DIAGNOSTIC stop_reason=${data.stop_reason} output_tokens=${data?.usage?.output_tokens} ` +
          `sceneCount=${sceneCount} — response may be truncated`
      );
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[split-script-beats] phase=locate-json no braces, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[split-script-beats] phase=parse-plan-json', e?.message, 'text=', clean.slice(0, 400));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.scenes) || plan.scenes.length !== sceneCount) {
      console.error('[split-script-beats] phase=validate scene count mismatch — got', plan?.scenes?.length, 'expected', sceneCount);
      return res.status(502).json({ error: 'AI response scene count mismatch' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[split-script-beats] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[generate-scenes] phase=config missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Final anti-repetition editorial pass — dispatched before any scene-chunk body validation below.
  if (req.body?.mode === 'repetition-audit') return repetitionAudit(req, res, apiKey);
  // "Paste your own script" mode (CreateStep.jsx) — see the header comment above splitScriptPlan.
  if (req.body?.mode === 'split-script') {
    return req.body?.stage === 'beats' ? splitScriptBeats(req, res, apiKey) : splitScriptPlan(req, res, apiKey);
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let topic, title, chapterTitle, chapterSummary, sceneCount, language, style, imageProvider, vertical;
    let characterBible, refs, previousTail, isVeryFirstChunk, isVeryLastChunk, creativeOverride, contentType, isStaticBackground;
    let channelIntroEnabled, niche;
    try {
      const body = req.body || {};
      topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      title = typeof body.title === 'string' ? body.title.trim() : '';
      chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.trim() : '';
      chapterSummary = typeof body.chapterSummary === 'string' ? body.chapterSummary.trim() : '';
      if (!topic || topic.length > 500) return res.status(400).json({ error: 'Invalid topic' });
      if (!chapterTitle) return res.status(400).json({ error: 'Invalid chapterTitle' });

      sceneCount = Math.round(Number(body.sceneCount));
      if (!Number.isFinite(sceneCount) || sceneCount <= 0) return res.status(400).json({ error: 'Invalid sceneCount' });
      sceneCount = Math.min(16, sceneCount);

      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'facestick';
      imageProvider = ['pollinations', 'nanobanana', 'gptimage'].includes(body.imageProvider) ? body.imageProvider : 'pollinations';
      vertical = body.format === '9:16';
      // 'static_background' — see api/generate-outline.js's own contentType handling for the full
      // rationale. Here it only changes the narration field's instruction and drops image_beats
      // from the schema entirely (sceneCount itself was already decided upstream by the outline
      // phase either way, so no chunking logic changes are needed in this file).
      contentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
      isStaticBackground = contentType === 'static_background';

      characterBible = parseCharacterBibleForBeats(body.characterBible);
      refs = parseReferencesForBeats(body.references);

      previousTail = typeof body.previousTail === 'string' ? body.previousTail.trim() : '';
      isVeryFirstChunk = !!body.isVeryFirstChunk;
      isVeryLastChunk = !!body.isVeryLastChunk;
      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';

      // Same channel self-introduction toggle as api/generate-outline.js — here it only feeds the
      // optional mid-video echo below (the welcome itself was already written into the first
      // chapter's outline by that earlier stage).
      channelIntroEnabled = body.channelIntroEnabled === true;
      niche = typeof body.niche === 'string' ? body.niche.trim() : '';
    } catch (err) {
      console.error('[generate-scenes] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    // Both sections below are entirely about assigning a reference photo / character appearance to
    // an image_beat — meaningless for static_background, which has no image_beats at all.
    const referenceSection = !isStaticBackground ? buildReferenceSection(refs) : '';
    const characterAssignmentSection = !isStaticBackground ? buildCharacterAssignmentSection(characterBible) : '';

    // static_background still benefits from knowing recurring names — purely so the narration
    // refers to the same person consistently (e.g. always "Maria", not switching to "the woman"
    // later) — none of the reference_id/character_id/variant_label image-assignment rules above
    // apply since there's no image_beat to assign them to.
    const characterNamingNote = isStaticBackground && characterBible.length
      ? `\n\nRecurring people/characters in this video (use these exact names consistently throughout the narration): ${characterBible
          .map((c) => c.name)
          .filter(Boolean)
          .join(', ')}.`
      : '';

    const imagePromptFieldDescription = buildImagePromptFieldDescription(imageProvider, vertical);

    // Tone-matched to each content type's own established narration style (full_pipeline: punchy/
    // conversational; static_background: calm/measured) — same substance either way: a brief recap
    // (key insight + a callback to the story's turning point) woven into the narration ahead of the
    // CTA, not a bullet-list summary bolted on at the end.
    const closingRecapNote = isStaticBackground
      ? `This chunk ends the entire video — before the closing call-to-action, include 1-2 scenes that calmly recap the single key concept or insight this video delivered, plus a brief callback to the pivotal moment of the story, phrased as a natural continuation of the narration, not a bullet list or a mechanical summary. It should feel like a settled, satisfying close that reinforces what the listener just learned, then move into the call-to-action (subscribe/watch next).`
      : `This chunk ends the entire video — before the final call-to-action, include 1-2 scenes that briefly recap the single key concept or insight this video delivered, plus a short callback to the pivotal/turning-point moment of the story, phrased naturally as part of the narration flow, not as a bullet list. It should feel like a satisfying close that reinforces what the viewer just learned or experienced, not a mechanical summary, then transition into the call-to-action (subscribe/watch next).`;

    // Optional, occasional callback to the channel's own purpose (ChannelDashboardStep.jsx's
    // "Include channel intro at video start" toggle) — deliberately left to the writer's own
    // judgment per chunk rather than forced onto a specific chapter picked by this endpoint: only
    // the model, writing the actual narration, can tell whether THIS chunk genuinely has a strong
    // hook or surprising turn worth the callback. Never applied to the very first or very last
    // chunk — those already carry the full welcome (outline stage) and the closing recap above.
    const midVideoEchoNote =
      channelIntroEnabled && niche && !isVeryFirstChunk && !isVeryLastChunk
        ? `If this chapter contains a particularly strong hook or surprising turn, you may briefly and naturally echo the channel's purpose ("${niche}") in 1 short sentence — only if it fits naturally, never forced.`
        : '';

    const continuityNote = [
      `You are writing scenes 1-${sceneCount} of the chapter '${chapterTitle}': ${chapterSummary}.`,
      previousTail
        ? `The previous scene ended with: "${previousTail}". Continue the narration naturally from there — no abrupt restart, no re-introduction of things already established.`
        : '',
      isVeryFirstChunk ? 'This chunk opens the entire video — it must open with the strongest hook.' : '',
      isVeryLastChunk ? closingRecapNote : '',
      midVideoEchoNote,
    ]
      .filter(Boolean)
      .join(' ');

    // Facts about THIS specific chunk (title, topic, chapter continuity) — always injected
    // regardless of which creative direction is active (default or a channel's override), since an
    // override changes HOW to write, never WHAT is being continued.
    const context = `Video title: "${title || topic}"
Topic: "${topic}"

${continuityNote}`;

    // Dashes (em/en/hyphen used as connecting punctuation) read naturally on a page but not aloud
    // — a voice engine either ignores them or renders an unnatural pause/inflection that doesn't
    // match how the sentence would actually be spoken. Applies to both content types' narration.
    const noDashesInstruction = `Never use em dashes, en dashes, or hyphens as punctuation within the narration (no " — " or " - " connecting clauses). Use only standard punctuation — periods, commas, semicolons — as in natural everyday written language. This text will be read aloud, and dashes don't reflect how people actually speak.`;

    // Exactly one sentence per scene, strictly — no "occasionally two" exception at all. This is
    // what makes the scene boundary and the sentence boundary the exact same thing, so the
    // on-screen caption/.srt cue can simply span the scene's own real, measured duration with zero
    // internal splitting logic — identical in spirit to full_pipeline's scene-boundary-exact sync,
    // just without image beats. A thought needing two sentences becomes two separate scenes.
    const narrationFieldDescription = isStaticBackground
      ? `what the voiceover says for this scene — write exactly ONE natural, complete sentence per scene, never more than one, no exceptions. If a thought naturally needs two sentences, split it into two separate scenes instead of combining them. The sentence must still sound natural and unhurried, suited for a language-learning listener, never fragmented or artificially clipped mid-thought. ${noDashesInstruction} Written in ${language}`
      : `what the voiceover says for this scene, 1-2 short punchy sentences, max 200 characters. ${noDashesInstruction} Written in ${language}`;

    // Only asked for on the chunk that actually ends the video — a top-level field, not something
    // buried inside a scene's narration, so the client can read it directly without parsing prose.
    // Feeds ChannelDashboardStep.jsx/App.jsx (saved onto the video record) and, later,
    // api/program-manager.js's pendingPromises context, so a promise made in one video's CTA can
    // actually surface as a high-priority suggestion for the next one.
    const promisedFollowUpField = isVeryLastChunk
      ? `,
  "promised_follow_up": "if the closing call-to-action promises a specific future topic (e.g. 'next time we'll cover...'), a short description of that topic; null if the CTA is generic (e.g. just 'subscribe for more')"`
      : '';

    // The output-format half — field names, types, and hard correctness rules the client's parsing
    // depends on. NEVER influenced by creativeOverride, in any case. static_background's schema has
    // no image_beats field at all — there is nothing to draw for this content type.
    const SCHEMA_INSTRUCTIONS = isStaticBackground
      ? `You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "scenes": [exactly ${sceneCount} objects: {
    "narration": "${narrationFieldDescription}"
  }]${promisedFollowUpField}
}

Rules:
- Each scene MUST be exactly one complete sentence — never two, never a full paragraph, and never a fixed word/character-count target. A thought needing two sentences is two scenes, not one.${characterNamingNote}`
      : `You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "scenes": [exactly ${sceneCount} objects: {
    "narration": "${narrationFieldDescription}",
    "image_beats": [exactly 2 objects: {
      "image_prompt": "${imagePromptFieldDescription}",
      "animation": one of "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "drift_up" | "static",
      "reference_id": string | null,
      "character_id": string | null,
      "variant_label": string | null
    }]
  }]${promisedFollowUpField}
}

Rules:
- image_prompt must be visually literal (an image model will draw exactly this), always in English regardless of narration language.
- If no reference photos are listed below, always set reference_id to null.${referenceSection}${characterAssignmentSection}`;

    const defaultCreativeDirection = isStaticBackground ? DEFAULT_CREATIVE_DIRECTION_STATIC_BACKGROUND : DEFAULT_CREATIVE_DIRECTION;
    const systemPrompt = `${context}\n\n${creativeOverride || defaultCreativeDirection}\n\n${SCHEMA_INSTRUCTIONS}`;

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
          // A full 16-scene full_pipeline chunk (MAX_SCENES_PER_CALL) is ~2 image_beats/scene with
          // long premium-provider prompts (character proper names + verbatim on-screen text) and
          // was landing right at the old 4000 ceiling — truncated mid-JSON → "Could not parse AI
          // JSON". 8000 leaves wide margin; the DIAGNOSTIC stop_reason/usage logs below confirm
          // whether it's now always enough.
          max_tokens: 8000,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: `Write scenes ${1}-${sceneCount} for the chapter "${chapterTitle}" of "${title || topic}". Respond with JSON only.`,
            },
          ],
        }),
      });
    } catch (err) {
      console.error('[generate-scenes] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[generate-scenes] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[generate-scenes] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    // Phase 4: parse the outer envelope JSON in its own try/catch — a 200 isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-scenes] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic returned a non-JSON response', detail: rawText.slice(0, 300) });
    }

    // Phase 5: pull out the model's text blocks.
    let raw;
    try {
      raw = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    } catch (err) {
      console.error('[generate-scenes] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    // DIAGNOSTIC: Anthropic says outright when it stopped because it hit max_tokens (8000 here) —
    // that truncates the JSON mid-object and is the most likely cause of a downstream parse failure.
    if (data?.stop_reason && data.stop_reason !== 'end_turn') {
      console.warn(
        `[generate-scenes] DIAGNOSTIC stop_reason=${data.stop_reason} output_tokens=${data?.usage?.output_tokens} ` +
          `chapter="${chapterTitle}" sceneCount=${sceneCount} — response may be truncated`
      );
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      dumpUnparsableSceneResponse('locate-json', { anthropicData: data, rawText: raw, cleanText: clean, chapterTitle, sceneCount });
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    // Phase 6: parse the model's actual JSON payload.
    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      dumpUnparsableSceneResponse('parse-plan-json', {
        anthropicData: data,
        rawText: raw,
        cleanText: clean,
        chapterTitle,
        sceneCount,
        parseError: e,
      });
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      dumpUnparsableSceneResponse('validate-plan-missing-scenes', { anthropicData: data, rawText: raw, cleanText: clean, chapterTitle, sceneCount });
      return res.status(502).json({ error: 'AI response missing scenes' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-scenes] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
