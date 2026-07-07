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

export const config = { maxDuration: 90 };

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

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let topic, title, chapterTitle, chapterSummary, sceneCount, language, style, imageProvider, vertical;
    let characterBible, refs, previousTail, isVeryFirstChunk, isVeryLastChunk;
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

      characterBible = Array.isArray(body.characterBible)
        ? body.characterBible
            .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id)
            .map((c) => ({
              id: c.id,
              name: typeof c.name === 'string' ? c.name : '',
              variants: Array.isArray(c.variants)
                ? c.variants.filter((v) => v && typeof v.label === 'string').map((v) => v.label)
                : [],
            }))
        : [];

      refs = Array.isArray(body.references)
        ? body.references
            .filter((r) => r && typeof r.id === 'string' && typeof r.label === 'string' && r.label.trim())
            .map((r) => ({ id: r.id, label: r.label.trim() }))
        : [];

      previousTail = typeof body.previousTail === 'string' ? body.previousTail.trim() : '';
      isVeryFirstChunk = !!body.isVeryFirstChunk;
      isVeryLastChunk = !!body.isVeryLastChunk;
    } catch (err) {
      console.error('[generate-scenes] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const referenceSection = refs.length
      ? `

You have been given these reference photos, each with a label describing who/what they depict and in what context:
${refs.map((r) => `- id: "${r.id}", label: "${r.label}"`).join('\n')}

For EVERY image beat where the main subject (the person these references depict) is visibly present — as the focal subject, in the background, or partially visible — you MUST set reference_id to the id of the reference whose label best matches that beat's time period, appearance, or context. Do NOT leave reference_id null just because no label is a perfect match: if multiple references exist for the same subject, pick the closest match by context rather than skipping. Only set reference_id to null when the subject is genuinely NOT depicted in that specific beat. When in doubt, default to using the reference photo rather than skipping it.

When reference_id is set, image_prompt MUST be an editing instruction, never a fresh description that ignores the photo: state explicitly to keep the subject's face, hairstyle and distinctive features from the reference photo, and describe ONLY what changes — in the exact form "keep the subject's face, hairstyle and distinctive features from the reference photo; change only: [scene/setting/action]". When reference_id is null, image_prompt works exactly as before (plain descriptive text-to-image).`
      : '';

    const characterAssignmentSection = characterBible.length
      ? `

Character bible for this video (already established — do NOT invent new characters, only ever use these exact ids):
${characterBible.map((c) => `- id: "${c.id}", name: "${c.name}"${c.variants.length ? `, variants: [${c.variants.map((l) => `"${l}"`).join(', ')}]` : ''}`).join('\n')}

For EVERY image beat where one of these characters is visibly present — as the focal subject, in the background, or partially visible — character_id and variant_label are REQUIRED: do NOT leave them null just because no variant is a perfect match, pick the closest one by that beat's narrative context. Only set character_id and variant_label to null when no character_bible character is genuinely depicted in that specific beat. If a beat has both a valid reference_id and a valid character_id for the same character, reference_id (a real photo) takes priority for the final image — character_id and variant_label are still saved as information regardless.`
      : '';

    // Pollinations (Flux/Kontext) has no real-world knowledge and cannot render legible text —
    // literal, name-free descriptions and a hard "no text" rule are what keep it on target.
    // Nano Banana 2 / GPT Image 2 are LLM-native: they recognize named real people and characters
    // and can render accurate on-screen text, so the instruction leans into both strengths instead
    // of fighting them.
    const premiumProvider = imageProvider === 'nanobanana' || imageProvider === 'gptimage';
    const imagePromptFieldDescription = premiumProvider
      ? `concrete visual description in English of ONE clear image illustrating a specific visual moment within this narration: one subject, one action, simple composition${vertical ? ', vertical composition' : ''}. Write it as a natural sentence that explicitly names the recognizable character/person by their proper name or title (e.g. "Legolas skateboarding in streetwear", not "a blond elf with pointed ears skateboarding") — trust the model's own knowledge for their appearance. Additionally: if this beat visually represents a specific number, statistic, price, percentage, or short quote mentioned in the narration, include the EXACT text to render on-screen in quotes within the prompt (e.g. a chart labeled "+340%"), and state it must be rendered verbatim, character-for-character accurate — never approximated or altered. Only do this when on-screen text genuinely aids comprehension (data/finance/stats content), not for purely narrative/scenic beats.`
      : `concrete visual description in English of ONE clear image illustrating a specific visual moment within this narration: one subject, one action, simple composition${vertical ? ', vertical composition' : ''}. Never include text, letters, numbers or signs in the image.`;

    const continuityNote = [
      `You are writing scenes 1-${sceneCount} of the chapter '${chapterTitle}': ${chapterSummary}.`,
      previousTail
        ? `The previous scene ended with: "${previousTail}". Continue the narration naturally from there — no abrupt restart, no re-introduction of things already established.`
        : '',
      isVeryFirstChunk ? 'This chunk opens the entire video — it must open with the strongest hook.' : '',
      isVeryLastChunk ? 'This chunk ends the entire video — its final scene must close with a call to action (subscribe/watch next).' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const systemPrompt = `You are a YouTube scriptwriter continuing a faceless animated video already in progress.

Video title: "${title || topic}"
Topic: "${topic}"

You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "scenes": [exactly ${sceneCount} objects: {
    "narration": "what the voiceover says for this scene, 1-2 short punchy sentences, max 200 characters, written in ${language}",
    "image_beats": [exactly 2 objects: {
      "image_prompt": "${imagePromptFieldDescription}",
      "animation": one of "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "drift_up" | "static",
      "reference_id": string | null,
      "character_id": string | null,
      "variant_label": string | null
    }]
  }]
}

Rules for scenes:
- Narration must flow naturally when read aloud in sequence, conversational tone, no scene numbers.
- Vary the animations; never use the same one twice in a row within a scene, and avoid repeating the same animation across consecutive scenes.
- Each scene's two image_beats must be visually distinct from each other — a different subject, moment, or camera framing that both illustrate the same narration from two angles. Never make the two beats the same image concept restated.
- image_prompt must be visually literal (an image model will draw exactly this), always in English regardless of narration language.
- If no reference photos are listed below, always set reference_id to null.${referenceSection}${characterAssignmentSection}

${continuityNote}`;

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
          max_tokens: 4000,
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

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[generate-scenes] phase=locate-json no braces found, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    // Phase 6: parse the model's actual JSON payload.
    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[generate-scenes] phase=parse-plan-json', e?.message, 'raw text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      console.error('[generate-scenes] phase=validate-plan missing/empty scenes, plan=', JSON.stringify(plan).slice(0, 300));
      return res.status(502).json({ error: 'AI response missing scenes' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-scenes] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
