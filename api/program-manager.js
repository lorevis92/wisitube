// WisiTube — Content Program Manager proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Looks at a channel holistically (niche, editorial notes, every video already made) and asks
// Claude — with web search enabled, same as api/generate.js — to propose what to produce next.
//
// Every phase has its own try/catch so a failure anywhere (request validation, the outbound
// fetch, reading the response body, parsing either layer of JSON) returns a clear JSON error with
// a phase tag instead of an uncaught rejection that Vercel turns into a generic platform 502.

export const config = { maxDuration: 90 };

// The "channel voice" half of the system prompt — editorial strategy, priorities, how to think
// about what to suggest next. Safe to override per-channel (see creativeOverride below): nothing
// here names required JSON fields, so swapping it can't break downstream parsing.
const DEFAULT_CREATIVE_DIRECTION = `You are an expert YouTube content strategist and program manager for a faceless channel. Your job is to look holistically at a channel — its niche, its editorial guidelines, and every video already made — and propose the next videos that will make the channel grow and stay coherent and bingeable. Think like a channel owner planning an editorial calendar, not like someone generating random ideas. Consider: gaps in coverage (important subjects/angles not yet covered), opportunities for SERIES (groups of 3-5 connected videos under a theme), natural progressions from existing content, and what would genuinely interest this audience. Use web search to stay current on the niche (trending topics, recent events, popular subjects people are searching for right now). Avoid suggesting anything too similar to videos already made.`;

// The output-format half — field names, types, "JSON only", and the refinement-bias contract.
// NEVER influenced by creativeOverride: the client's JSON parsing depends on this exact shape
// regardless of what creative direction is in play.
const SCHEMA_INSTRUCTIONS = `You MUST respond with ONLY valid JSON, no markdown, no preamble. Schema: { "analysis": "2-3 sentence holistic read of where the channel stands and what it needs", "suggestions": [6-8 objects: { "title": "clickable video title", "angle": "one sentence on what makes it interesting / why now", "series": "series name if part of a proposed series, else null", "priority": "high|medium|low" }] }. If a refinement instruction is provided, bias all suggestions toward it.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[program-manager] phase=config missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Outer safety net: the phase-specific catches below should handle everything, but this
  // guarantees we never let an uncaught exception fall through to a platform-level 502.
  try {
    // Phase 1: validate and sanitize the request body.
    let channelName, niche, editorialNotes, videos, refinement, creativeOverride;
    try {
      const body = req.body || {};
      channelName = typeof body.channelName === 'string' ? body.channelName.trim() : '';
      if (!channelName || channelName.length > 200) {
        return res.status(400).json({ error: 'Invalid channelName' });
      }
      niche = typeof body.niche === 'string' ? body.niche.trim() : '';
      editorialNotes = typeof body.editorialNotes === 'string' ? body.editorialNotes.trim() : '';
      refinement = typeof body.refinement === 'string' ? body.refinement.trim() : '';
      videos = Array.isArray(body.existingVideos)
        ? body.existingVideos
            .filter((v) => v && typeof v === 'object')
            .map((v) => ({
              title: typeof v.title === 'string' ? v.title.trim() : '',
              topic: typeof v.topic === 'string' ? v.topic.trim() : '',
            }))
            .filter((v) => v.title || v.topic)
        : [];
      creativeOverride = typeof body.creativeOverride === 'string' ? body.creativeOverride.trim() : '';
    } catch (err) {
      console.error('[program-manager] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    const systemPrompt = `${creativeOverride || DEFAULT_CREATIVE_DIRECTION} ${SCHEMA_INSTRUCTIONS}`;

    const userContent = [
      `Channel name: ${channelName}`,
      `Niche: ${niche || '(not specified)'}`,
      editorialNotes ? `Editorial notes: ${editorialNotes}` : '',
      videos.length
        ? `Videos already made (${videos.length}):\n${videos.map((v) => `- "${v.title || v.topic}"${v.topic && v.title ? ` (topic: ${v.topic})` : ''}`).join('\n')}`
        : 'No videos made yet — this is a brand new channel.',
      refinement ? `Refinement instruction from the user — bias ALL suggestions toward this: ${refinement}` : '',
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
          max_tokens: 4000,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: userContent }],
        }),
      });
    } catch (err) {
      console.error('[program-manager] phase=fetch-anthropic', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not reach the Anthropic API', detail: String(err?.message || err).slice(0, 300) });
    }

    // Phase 3: read the raw response body — never assume it's JSON before checking.
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      console.error('[program-manager] phase=read-response-body', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read the Anthropic response body', detail: String(err?.message || err).slice(0, 300) });
    }

    if (!response.ok) {
      console.error('[program-manager] phase=anthropic-http-error status=', response.status, 'body=', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Anthropic API error', detail: rawText.slice(0, 300) });
    }

    // Phase 4: parse the outer envelope JSON in its own try/catch — a 200 isn't guaranteed to be JSON.
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('[program-manager] phase=parse-envelope-json', err?.message, 'raw body=', rawText.slice(0, 300));
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
      console.error('[program-manager] phase=extract-text-blocks', err?.message, err?.stack);
      return res.status(502).json({ error: 'Could not read Anthropic response content', detail: String(err?.message || err).slice(0, 300) });
    }

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[program-manager] phase=locate-json no braces found, text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    // Phase 6: parse the model's actual JSON payload in its own try/catch.
    let plan;
    try {
      plan = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error('[program-manager] phase=parse-plan-json', e?.message, 'raw text=', clean.slice(0, 300));
      return res.status(502).json({ error: 'Could not parse AI JSON', detail: String(e).slice(0, 300) });
    }

    if (!Array.isArray(plan.suggestions) || plan.suggestions.length === 0) {
      console.error('[program-manager] phase=validate-plan missing/empty suggestions, plan=', JSON.stringify(plan).slice(0, 300));
      return res.status(502).json({ error: 'AI response missing suggestions' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[program-manager] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
