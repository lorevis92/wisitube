// WisiTube — Content Program Manager proxy (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Looks at a channel holistically (niche, editorial notes, every video already made) and asks
// Claude — with web search enabled, same as api/generate.js — to propose what to produce next.
// Three modes, dispatched by body.mode, all sharing this one file rather than three separate
// functions — Vercel Hobby caps a deployment at 12 Serverless Functions (see api/youtube.js's own
// header comment); scripts/check-function-count.js now guards the count at build time, keeping a
// deliberate buffer below that cap:
//   mode=suggest (default)  — the original behavior above/below: a broad qualitative candidate batch.
//   mode=synthesize         — see the SYNTHESIZE_* constants: selects/ranks a scored batch.
//   mode=chat               — see CHAT_SYSTEM_PROMPT: a conversation with the channel owner about
//                              this assistant's own suggestion behavior, which can end in a proposed
//                              creative-direction update (see src/components/ProgramManagerChat.jsx).
//
// Every phase has its own try/catch so a failure anywhere (request validation, the outbound
// fetch, reading the response body, parsing either layer of JSON) returns a clear JSON error with
// a phase tag instead of an uncaught rejection that Vercel turns into a generic platform 502.
//
// maxDuration set near this plan's ceiling (280s), not the previous 90s: mode=suggest now proposes
// a wider batch (14, not 6-8 — see src/lib/contentProgramManager.js) with web_search enabled, which
// can run multiple search rounds well past 90s, and mode=synthesize is a second Claude call in the
// same A→B→C pipeline. A function killed for exceeding maxDuration is a platform-level 504 with a
// non-JSON body — none of the try/catches below can catch or soften that, so the fix has to be
// giving Claude enough real time, not a nicer error message on this end.
export const config = { maxDuration: 280 };

// The "channel voice" half of the system prompt — editorial strategy, priorities, how to think
// about what to suggest next. Safe to override per-channel (see creativeOverride below): nothing
// here names required JSON fields, so swapping it can't break downstream parsing.
const DEFAULT_CREATIVE_DIRECTION = `You are an expert YouTube content strategist and program manager for a faceless channel. Your job is to look holistically at a channel — its niche, its editorial guidelines, and every video already made — and propose the next videos that will make the channel grow and stay coherent and bingeable. Think like a channel owner planning an editorial calendar, not like someone generating random ideas. Consider: gaps in coverage (important subjects/angles not yet covered), opportunities for SERIES (groups of 3-5 connected videos under a theme), natural progressions from existing content, and what would genuinely interest this audience. Use web search to stay current on the niche (trending topics, recent events, popular subjects people are searching for right now). Avoid suggesting anything too similar to videos already made.`;

// The output-format half — field names, types, "JSON only", and the refinement-bias contract.
// NEVER influenced by creativeOverride: the client's JSON parsing depends on this exact shape
// regardless of what creative direction is in play. Takes the suggestion count as a parameter
// (default the original 6-8 spread) since a per-suggestion replacement (see ChannelDashboardStep.jsx
// "Start this video"/count: 1) asks for exactly one instead of a full batch.
// fulfills_promise_video_id: optional — set only when a suggestion is the one that pays off a
// pending promise from pendingPromises below (see the system-prompt addition in the handler). The
// client uses this to mark the ORIGINAL video's promise as fulfilled once this suggestion is
// actually started (see ChannelDashboardStep.jsx/fullPipelineRecipe.js/staticBackgroundRecipe.js).
const schemaInstructions = (suggestionCountText) =>
  `You MUST respond with ONLY valid JSON, no markdown, no preamble. Schema: { "analysis": "2-3 sentence holistic read of where the channel stands and what it needs", "suggestions": [${suggestionCountText} objects: { "title": "clickable video title", "angle": "one sentence on what makes it interesting / why now", "series": "series name if part of a proposed series, else null", "priority": "high|medium|low", "fulfills_promise_video_id": "the video id from the pending-promises list this suggestion fulfills, or null" }] }. If a refinement instruction is provided, bias all suggestions toward it.`;

// ---- mode=synthesize ----
//
// Second half of the cached scoring pipeline (see src/lib/contentProgramManager.js): mode=suggest
// (the default, everything above/below) proposes a broad, purely qualitative candidate batch with
// no real data behind it yet. Those candidates then get scored against real Trends/YouTube data
// (api/topic-scoring.js), and THIS mode takes that scored batch back and asks Claude to select and
// rank the final shortlist — combining its own original editorial judgment with the now-available
// real numbers, not a mechanical re-sort by score. No web_search tool here: this pass reasons over
// data already gathered, it doesn't need to research anything new.
const SYNTHESIZE_CREATIVE_DIRECTION = `You are an expert YouTube content strategist finishing a two-stage editorial process for a faceless channel. In stage one, a broad batch of candidate video topics was proposed for this channel based on qualitative judgment alone (niche fit, series continuity, pending promises, editorial directive). Those candidates have since been scored against real data: recent Google Trends growth (score is a 0-100 "favorability" blend of trend growth and low recent YouTube competition — higher is better; see each candidate's own reasoning string for the actual numbers behind it). Some candidates have signal_incomplete: true, meaning one or both real signals couldn't be computed (an API error, or too little Trends data for a niche keyword) — that is NOT the same as a bad score, treat those candidates on editorial judgment, don't penalize them for missing data. Your job: select and RANK the strongest candidates by combining your original editorial instincts with this real data. A candidate with weaker numbers can still rank highly for a good editorial reason (e.g. it completes an already-started series, or fulfills a pending promise) — a candidate with great numbers isn't automatically top pick if it's off-brand, redundant, or thin. This is a synthesis, not a mechanical re-sort by score — your rationale for each pick should show that reasoning, citing the real numbers when they support the decision.`;

const SYNTHESIZE_SCHEMA_INSTRUCTIONS = `You MUST respond with ONLY valid JSON, no markdown, no preamble. Schema: { "finalSuggestions": [6 to 8 objects, ordered BEST FIRST: { "title": "must exactly match one of the candidate titles given to you, verbatim", "priority": "high|medium|low", "rationale": "1-2 sentences on why this made the final cut — cite the real numbers when they support the decision, or state the editorial reason when overriding a weak or incomplete signal" }] }.`;

// ---- mode=chat ----
//
// Conversational counterpart to the suggest/synthesize modes above — same Content Program Manager
// "persona," but talking directly to the channel owner about its own behavior instead of producing
// a batch of suggestions. Plain-text reply, not JSON: skips the schema/brace-parsing phases entirely
// (see the handler below). No web_search tool: this is a conversation about context already given,
// not a research task.
//
// Ends with a machine-parseable <PROPOSED_UPDATE>...</PROPOSED_UPDATE> block only when the owner has
// explicitly agreed to a change — src/components/ProgramManagerChat.jsx extracts that block and, on
// confirmation, saves it through the exact same channel.prompt_overrides.programManager path the
// Prompt Lab already uses (including its version history) — this endpoint itself never writes
// anything, it only ever proposes text.
const CHAT_SYSTEM_PROMPT = `You are this channel's Content Program Manager, having a direct conversation with the channel owner about your own suggestion behavior. Explain your past reasoning honestly when asked, using the real context provided — never invent justifications. When the owner explicitly agrees on a change to how you should operate going forward, propose the updated creative direction as a complete replacement text, wrapped in a clearly delimited block: <PROPOSED_UPDATE>full updated creative direction text here</PROPOSED_UPDATE>. Only propose an update when there's clear agreement on a specific change — casual discussion doesn't need one. Never propose changes to the technical JSON schema, only to editorial/creative guidance.`;

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
    let mode, channelName, niche, editorialNotes, videos, refinement, creativeOverride, activeDirective, existingPlaylists, count, avoidTitles, pendingPromises, analysis, scoredCandidates, chatMessages, recentSuggestions;
    try {
      const body = req.body || {};
      mode = body.mode === 'synthesize' ? 'synthesize' : body.mode === 'chat' ? 'chat' : 'suggest';
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
      // Channel owner's standing series/initiative instruction (src/lib/db.js automation_directive)
      // — takes priority over the general creative direction, see the system prompt below.
      activeDirective = typeof body.activeDirective === 'string' ? body.activeDirective.trim() : '';
      // The channel's existing YouTube playlists (src/lib/youtubePublishEngine.js
      // listChannelPlaylists) — context so suggestions prefer continuing one over always
      // inventing a new series.
      existingPlaylists = Array.isArray(body.existingPlaylists)
        ? body.existingPlaylists
            .filter((p) => p && typeof p === 'object')
            .map((p) => ({ name: typeof p.name === 'string' ? p.name.trim() : '', videoCount: Number(p.videoCount) || 0 }))
            .filter((p) => p.name)
        : [];
      // How many suggestions to generate — null (the original 6-8 spread) unless the caller asks
      // for a specific number, e.g. ChannelDashboardStep.jsx's single-suggestion replacement flow
      // (count: 1) after one is started or dismissed.
      count = Number.isFinite(Number(body.count)) && Number(body.count) > 0 ? Math.min(20, Math.round(Number(body.count))) : null;
      // Titles/ideas to explicitly steer away from — dismissed suggestions, remaining suggestions
      // already on the list, and/or existing video titles, combined by the caller (see
      // ChannelDashboardStep.jsx) — on top of (not instead of) the existingVideos list already
      // baked into userContent below.
      avoidTitles = Array.isArray(body.avoidTitles)
        ? body.avoidTitles.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 200)
        : [];
      // Videos on this channel whose closing CTA promised a specific future topic, not yet
      // addressed (src/lib/db.js listPendingPromises) — see the system-prompt addition below.
      pendingPromises = Array.isArray(body.pendingPromises)
        ? body.pendingPromises
            .filter((p) => p && typeof p === 'object' && typeof p.videoId === 'string' && p.videoId && typeof p.promise === 'string' && p.promise.trim())
            .map((p) => ({
              videoId: p.videoId,
              videoTitle: typeof p.videoTitle === 'string' ? p.videoTitle.trim() : '',
              promise: p.promise.trim(),
            }))
            .slice(0, 50)
        : [];
      // mode=synthesize's own inputs — the stage-one holistic read and the scored candidate batch
      // (see api/topic-scoring.js) it needs to select and rank from. Kept in the same try/catch as
      // the suggest-mode fields above rather than a separate block: harmless to parse (and leave
      // empty) regardless of which mode this request is actually using.
      analysis = typeof body.analysis === 'string' ? body.analysis.trim() : '';
      scoredCandidates = Array.isArray(body.scoredCandidates)
        ? body.scoredCandidates
            .filter((c) => c && typeof c === 'object' && typeof c.title === 'string' && c.title.trim())
            .map((c) => ({
              title: c.title.trim(),
              angle: typeof c.angle === 'string' ? c.angle.trim() : '',
              series: typeof c.series === 'string' && c.series.trim() ? c.series.trim() : null,
              priority: typeof c.priority === 'string' ? c.priority.trim() : 'medium',
              fulfills_promise_video_id: typeof c.fulfills_promise_video_id === 'string' && c.fulfills_promise_video_id ? c.fulfills_promise_video_id : null,
              score: Number.isFinite(Number(c.score)) ? Number(c.score) : null,
              signal_incomplete: !!c.signal_incomplete,
              reasoning: typeof c.reasoning === 'string' ? c.reasoning.trim() : '',
            }))
            .slice(0, 30)
        : [];
      if (mode === 'synthesize' && scoredCandidates.length === 0) {
        return res.status(400).json({ error: 'Invalid scoredCandidates' });
      }

      // mode=chat's own inputs — the full conversation so far, and (for context, not validation)
      // the channel's most recently scored/synthesized suggestions with their real reasoning, so
      // the assistant can honestly explain past behavior instead of guessing at it.
      chatMessages = Array.isArray(body.messages)
        ? body.messages
            .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 8000) }))
            .slice(-40)
        : [];
      recentSuggestions = Array.isArray(body.recentSuggestions)
        ? body.recentSuggestions
            .filter((s) => s && typeof s === 'object' && typeof s.title === 'string' && s.title.trim())
            .map((s) => ({
              title: s.title.trim(),
              priority: typeof s.priority === 'string' ? s.priority.trim() : 'medium',
              rationale: typeof s.rationale === 'string' ? s.rationale.trim() : '',
              reasoning: typeof s.reasoning === 'string' ? s.reasoning.trim() : '',
            }))
            .slice(0, 20)
        : [];
      if (mode === 'chat' && chatMessages.length === 0) {
        return res.status(400).json({ error: 'Invalid messages' });
      }
    } catch (err) {
      console.error('[program-manager] phase=validate-body', err?.message, err?.stack);
      return res.status(400).json({ error: 'Invalid request body', detail: String(err?.message || err).slice(0, 300) });
    }

    let systemPrompt, userContent, maxTokens, tools, anthropicMessages;
    if (mode === 'chat') {
      // ---- mode=chat prompt ----
      systemPrompt = CHAT_SYSTEM_PROMPT;
      systemPrompt += `\n\nChannel: ${channelName}. Niche: ${niche || '(not specified)'}.`;
      if (editorialNotes) systemPrompt += ` Editorial notes: ${editorialNotes}`;
      systemPrompt += `\n\nYour current creative direction — this is what actually governs your suggestion behavior right now (the channel owner's custom override if they've set one, otherwise your own default):\n${creativeOverride || DEFAULT_CREATIVE_DIRECTION}`;
      if (videos.length) {
        systemPrompt += `\n\nRecent videos on this channel:\n${videos.map((v) => `- "${v.title || v.topic}"`).join('\n')}`;
      }
      if (recentSuggestions.length) {
        systemPrompt += `\n\nYour most recent suggestions and the real reasoning behind them:\n${recentSuggestions
          .map((s) => `- "${s.title}" [${s.priority}]: ${s.rationale || s.reasoning || '(no rationale recorded)'}`)
          .join('\n')}`;
      }
      anthropicMessages = chatMessages;
      maxTokens = 1500;
      tools = undefined; // a conversation about context already given, not a research task
    } else if (mode === 'synthesize') {
      // ---- mode=synthesize prompt ----
      systemPrompt = creativeOverride || SYNTHESIZE_CREATIVE_DIRECTION;
      if (activeDirective) {
        systemPrompt += ` The channel owner has an active creative directive that takes priority: "${activeDirective}". Weigh this heavily in your final selection.`;
      }
      systemPrompt += ` ${SYNTHESIZE_SCHEMA_INSTRUCTIONS}`;

      const candidateLines = scoredCandidates
        .map((c, i) => {
          const scoreText = c.score === null ? 'N/A' : c.score;
          return `${i + 1}. "${c.title}"${c.series ? ` [series: ${c.series}]` : ''} — angle: ${c.angle || '(none)'}. Original priority guess: ${c.priority}${c.fulfills_promise_video_id ? '. Fulfills a pending promise.' : ''} Real signal score: ${scoreText}${c.signal_incomplete ? ' (incomplete)' : ''} — ${c.reasoning || 'no data'}`;
        })
        .join('\n');
      userContent = [
        `Channel name: ${channelName}`,
        niche ? `Niche: ${niche}` : '',
        editorialNotes ? `Editorial notes: ${editorialNotes}` : '',
        analysis ? `Stage-one holistic analysis of this channel: ${analysis}` : '',
        `Scored candidates:\n${candidateLines}`,
        'Respond with JSON only.',
      ]
        .filter(Boolean)
        .join('\n\n');
      maxTokens = 2000;
      tools = undefined; // reasoning over already-gathered data — no need to research anything new
    } else {
      // ---- mode=suggest prompt (default, unchanged) ----
      systemPrompt = creativeOverride || DEFAULT_CREATIVE_DIRECTION;
      if (activeDirective) {
        systemPrompt += ` The channel owner has an active creative directive that takes priority over general suggestions: "${activeDirective}". Your suggestions must primarily serve this directive — check the existing videos list to see what's already been covered under it, and propose the logical next step, not a repeat or an unrelated idea. Only fall back to general channel-growth suggestions if the directive appears fully satisfied by existing content.`;
      }
      if (pendingPromises.length) {
        const promiseList = pendingPromises
          .map((p) => `- id "${p.videoId}"${p.videoTitle ? ` (from "${p.videoTitle}")` : ''}: ${p.promise}`)
          .join('\n');
        systemPrompt += ` The following videos on this channel made an explicit promise to cover something in a future video, not yet fulfilled — treat fulfilling these as HIGH priority in your suggestions, above generic growth ideas (unless a directive is active, which still takes precedence): ${promiseList}. When a suggestion fulfills one of these, set a new field fulfills_promise_video_id to that video's id.`;
      }
      if (existingPlaylists.length) {
        const playlistList = existingPlaylists
          .map((p) => `"${p.name}" (${p.videoCount} video${p.videoCount === 1 ? '' : 's'})`)
          .join(', ');
        systemPrompt += ` This channel already has these YouTube playlists: ${playlistList}. When a suggestion is part of a series, prefer continuing one of these existing playlists when relevant, rather than always inventing a brand new one — continuity keeps the channel's series coherent and bingeable.`;
      }
      if (avoidTitles.length) {
        systemPrompt += ` Avoid suggesting anything substantially similar to these previously rejected or already-covered ideas: ${avoidTitles.join('; ')}`;
      }
      systemPrompt += ` ${schemaInstructions(count ? `exactly ${count}` : '6-8')}`;

      userContent = [
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
      maxTokens = 4000;
      tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }
    // suggest/synthesize both send a single user turn built above; chat sends the real multi-turn
    // history instead (already assigned in its own branch).
    if (!anthropicMessages) anthropicMessages = [{ role: 'user', content: userContent }];

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
          max_tokens: maxTokens,
          system: systemPrompt,
          ...(tools ? { tools } : {}),
          messages: anthropicMessages,
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

    // mode=chat replies in plain conversational text, not JSON — nothing left to parse, the raw
    // text (optionally containing a <PROPOSED_UPDATE> block the client extracts) IS the response.
    if (mode === 'chat') {
      if (!raw.trim()) {
        console.error('[program-manager] phase=validate-chat-reply empty reply');
        return res.status(502).json({ error: 'AI returned an empty reply' });
      }
      return res.status(200).json({ reply: raw.trim() });
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

    if (mode === 'synthesize') {
      if (!Array.isArray(plan.finalSuggestions) || plan.finalSuggestions.length === 0) {
        console.error('[program-manager] phase=validate-plan missing/empty finalSuggestions, plan=', JSON.stringify(plan).slice(0, 300));
        return res.status(502).json({ error: 'AI response missing finalSuggestions' });
      }
    } else if (!Array.isArray(plan.suggestions) || plan.suggestions.length === 0) {
      console.error('[program-manager] phase=validate-plan missing/empty suggestions, plan=', JSON.stringify(plan).slice(0, 300));
      return res.status(502).json({ error: 'AI response missing suggestions' });
    }

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[program-manager] phase=unexpected', err?.message, err?.stack);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err).slice(0, 300) });
  }
}
