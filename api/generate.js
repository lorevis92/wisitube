// WisiTube — Anthropic proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.

export const config = { maxDuration: 60 };

const SCENE_COUNTS = { short: 10, medium: 16, long: 24 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const {
      topic,
      language = 'English',
      length = 'short',
      format = '16:9',
      style = 'facestick',
      references,
      character_hints: characterHints,
      general_notes: generalNotes,
    } = req.body || {};
    if (!topic || typeof topic !== 'string' || topic.length > 500) {
      return res.status(400).json({ error: 'Invalid topic' });
    }

    const sceneCount = SCENE_COUNTS[length] || SCENE_COUNTS.short;
    const vertical = format === '9:16';

    // Client sends only { id, label } — never the file/blob — so sanitize defensively regardless.
    const refs = Array.isArray(references)
      ? references
          .filter((r) => r && typeof r.id === 'string' && typeof r.label === 'string' && r.label.trim())
          .map((r) => ({ id: r.id, label: r.label.trim() }))
      : [];

    const hints = Array.isArray(characterHints)
      ? characterHints
          .filter((c) => c && typeof c === 'object' && ((typeof c.name === 'string' && c.name.trim()) || (typeof c.details === 'string' && c.details.trim())))
          .map((c) => ({ name: typeof c.name === 'string' ? c.name.trim() : '', details: typeof c.details === 'string' ? c.details.trim() : '' }))
      : [];
    const notes = typeof generalNotes === 'string' ? generalNotes.trim() : '';

    const referenceSection = refs.length
      ? `

You have been given these reference photos, each with a label describing who/what they depict and in what context:
${refs.map((r) => `- id: "${r.id}", label: "${r.label}"`).join('\n')}

For EVERY image beat where the main subject (the person these references depict) is visibly present — as the focal subject, in the background, or partially visible — you MUST set reference_id to the id of the reference whose label best matches that beat's time period, appearance, or context. Do NOT leave reference_id null just because no label is a perfect match: if multiple references exist for the same subject, pick the closest match by context (era, hairstyle, setting described in the narration) rather than skipping. Only set reference_id to null when the subject is genuinely NOT depicted in that specific beat — for example: a beat showing only other people, crowds, objects, empty locations, maps, or abstract concepts unrelated to the subject's physical appearance. When in doubt about which reference fits best, default to using the reference photo rather than skipping it — a close-enough match is better than a generic AI-generated face for the main subject of the video.

When reference_id is set, image_prompt MUST be an editing instruction, never a fresh description that ignores the photo: state explicitly to keep the subject's face, hairstyle and distinctive features from the reference photo, and describe ONLY what changes — in the exact form "keep the subject's face, hairstyle and distinctive features from the reference photo; change only: [scene/setting/action]". When reference_id is null, image_prompt works exactly as before (plain descriptive text-to-image).`
      : '';

    const characterBibleSection = `

Character bible: identify every character that appears in more than one scene — including the narrator/protagonist even if not explicitly named by the user. For well-known real figures, use your own knowledge of their actual appearance. If the user provided character hints in their message, prioritize those details over your own assumptions. Create at least 2 variants when the story spans different life stages, time periods, or notable appearance changes (e.g. young vs old, before/after a transformation) — otherwise a single variant is enough. Every variant must preserve the base_description's core identifying traits while adapting era-specific details, so the character stays recognizable across variants.

For EVERY image beat where a character_bible character is visibly present — as the focal subject, in the background, or partially visible — character_id and variant_label are REQUIRED, same assertive logic as reference_id above: do NOT leave them null just because no variant is a perfect match, pick the closest one by that beat's narrative context. Only set character_id and variant_label to null when no character_bible character is genuinely depicted in that specific beat. If a beat has both a valid reference_id and a valid character_id for the same character, reference_id (a real photo) takes priority for the final image — character_id and variant_label are still saved as information regardless.`;

    const systemPrompt = `You are a YouTube strategist and scriptwriter for successful faceless animated channels.
You create videos that hook viewers in the first 3 seconds and keep retention high with a clear narrative arc.

You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no preamble, no explanation. Just raw JSON.

JSON schema:
{
  "titles": [5 strings — highly clickable YouTube titles, curiosity-driven but not misleading, max 70 chars each],
  "description": "SEO-optimized YouTube description, 3-5 sentences, includes a hook line and 3 relevant hashtags at the end",
  "tags": [15 short SEO tag strings],
  "thumbnail_concepts": [3 objects: { "overlay_text": "punchy text max 4 words UPPERCASE", "image_prompt": "concrete visual description in English for an AI image generator, one strong focal subject, exaggerated emotion, no text in image" }],
  "character_bible": [array of objects, one per recurring character: { "id": string, "name": string, "base_description": "distinctive traits that NEVER change: face shape, build, defining features — 1-2 sentences", "variants": [{ "label": "e.g. Young Napoleon, 1790s", "description": "traits specific to this era/stage: hair, clothing, age markers — 1-2 sentences" }] }],
  "scenes": [exactly ${sceneCount} objects: {
    "narration": "what the voiceover says for this scene, 1-2 short punchy sentences, max 200 characters, written in ${language}",
    "image_beats": [exactly 2 objects: {
      "image_prompt": "concrete visual description in English of ONE clear image illustrating a specific visual moment within this narration: one subject, one action, simple composition${vertical ? ', vertical composition' : ''}. Never include text, letters, numbers or signs in the image.",
      "animation": one of "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "drift_up" | "static",
      "reference_id": string | null,
      "character_id": string | null,
      "variant_label": string | null
    }]
  }]
}

Rules for scenes:
- Scene 1 is the HOOK: open with the most surprising fact or question.
- Build a clear arc: hook, development, payoff, and a final scene with a call to action (subscribe / watch next).
- Narration must flow naturally when read aloud in sequence, conversational tone, no scene numbers.
- Vary the animations; never use the same one twice in a row within a scene, and avoid repeating the same animation across consecutive scenes.
- Each scene's two image_beats must be visually distinct from each other — a different subject, moment, or camera framing that both illustrate the same narration from two angles (e.g. narration "Rome conquered most of the known world, then collapsed in decades" → beat 1: the empire at its peak, beat 2: its ruins / the collapse). Never make the two beats the same image concept restated.
- image_prompt must be visually literal (an image model will draw exactly this), always in English regardless of narration language.
- If no reference photos are listed below, always set reference_id to null.${referenceSection}${characterBibleSection}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: [
          {
            role: 'user',
            content: `Create the complete faceless video plan for this topic: "${topic}". Visual style of the channel: ${style}. Video length: ${length}.${
              hints.length
                ? `\n\nKnown characters (use these details, prioritize them over your own assumptions):\n${hints
                    .map((h) => `- ${h.name || 'Unnamed character'}: ${h.details || '(no physical details given — infer if well-known, otherwise use your judgment)'}`)
                    .join('\n')}`
                : ''
            }${notes ? `\n\nGeneral notes on tone, setting and recurring elements: ${notes}` : ''} Respond with JSON only.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Anthropic API error', detail: errText.slice(0, 300) });
    }

    const data = await response.json();
    const raw = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(502).json({ error: 'Invalid AI response' });

    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e) });
    }

    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      return res.status(502).json({ error: 'AI response missing scenes' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 300) });
  }
}
