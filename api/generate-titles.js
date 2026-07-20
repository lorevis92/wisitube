// WisiTube — Titles generation proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// First stage of the titles → outline → scenes pipeline: a short, fast call that lets the user
// pick a title and its narrative angle before any of the heavier outline/scene-writing work runs.
//
// Every phase has its own try/catch so a failure anywhere returns a clear JSON error with a phase
// tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 30 };

// The "channel voice" half of the system prompt — tone, editorial priorities, how to approach the
// task. Safe to override per-channel (see creativeOverride below): nothing here constrains the
// output format, so swapping it can't break downstream parsing.
const DEFAULT_CREATIVE_DIRECTION = `You are a YouTube strategist for successful faceless animated channels. Given a topic, propose 5 distinct, highly clickable video titles — curiosity-driven but not misleading, max 70 chars each. Each title implies a specific narrative angle (what the video will actually focus on), and the 5 angles must be genuinely different from each other — not just reworded versions of the same idea. For each title, write "angle": one short phrase naming that specific narrative cut (e.g. for the title "Why Napoleon Lost in Russia" the angle is "focus on the strategic blunder"; for the title "The Winter That Destroyed an Empire" the angle is "focus on human suffering").`;

// The output-format half — field names, types, "JSON only". NEVER influenced by creativeOverride:
// the client's JSON parsing (see below) depends on this exact shape regardless of what creative
// direction is in play.
const SCHEMA_INSTRUCTIONS = `You MUST respond with ONLY valid JSON, no markdown, no preamble. Schema: { "titles": [5 objects: { "title": string, "angle": string }] }.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[generate-titles] phase=config missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate the request body.
    let topic, language, creativeOverride;
    try {
      const body = req.body || {};
      topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'English';
      if (!topic || topic.length > 500) {
        return res.status(400).json({ error: 'Invalid topic' });
      }
      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';
    } catch (err) {
      console.error('[generate-titles] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const systemPrompt = `${creativeOverride || DEFAULT_CREATIVE_DIRECTION} ${SCHEMA_INSTRUCTIONS}`;

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
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Topic: "${topic}". Narration language: ${language}. Respond with JSON only.` }],
        }),
      });
    } catch (err) {
      console.error('[generate-titles] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
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

    // Phase 4: parse the outer envelope JSON in its own try/catch — a 200 isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[generate-titles] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
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

    // Phase 6: parse the model's actual JSON payload.
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

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[generate-titles] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
