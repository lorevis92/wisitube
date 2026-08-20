// Conversational interface to the Content Program Manager (api/program-manager.js, mode=chat) —
// lets the channel owner ask why it suggested what it did and, on explicit agreement, propose an
// update to its own creative direction. History is kept in local component state only for this
// first version — not persisted across sessions/reloads, same as any other in-progress draft in
// this app that hasn't been explicitly saved yet.
//
// onApplyUpdate(text): pre-bound by the caller (ChannelDashboardStep.jsx) to save through the exact
// same channel.prompt_overrides.programManager path the Prompt Lab already uses (including its
// version history) — this component never touches Supabase directly, it only ever asks the parent
// to apply text it already showed the user.
import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';

const PROPOSED_UPDATE_RE = /<PROPOSED_UPDATE>([\s\S]*?)<\/PROPOSED_UPDATE>/;

// Same defensive pattern as src/lib/contentProgramManager.js's postJSON — reads the raw body before
// parsing, so a platform-level failure (e.g. this endpoint's own maxDuration killing the request,
// which comes back as a non-JSON body) surfaces as a readable error instead of a bare, context-free
// SyntaxError from res.json() itself.
async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`${url} returned a non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 150) || '(empty body)'}`);
  }
  return { ok: res.ok, data };
}

// Splits an assistant reply into the plain-text part (shown in the chat bubble) and, when present,
// the proposed creative-direction text (shown separately with its own Apply button) — the raw
// <PROPOSED_UPDATE> tags themselves are never shown to the user.
function splitReply(text) {
  const match = text.match(PROPOSED_UPDATE_RE);
  if (!match) return { text, proposal: null };
  const remaining = text.replace(PROPOSED_UPDATE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: remaining, proposal: match[1].trim() };
}

export default function ProgramManagerChat({ channel, videos, onApplyUpdate, onClose }) {
  const [messages, setMessages] = useState([]); // [{ role, text, proposal, applied }]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [applyingIndex, setApplyingIndex] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending || !channel) return;
    setInput('');
    setError('');
    const history = [...messages, { role: 'user', text }];
    setMessages(history);
    setSending(true);
    try {
      const recentSuggestions = (channel.topic_scoring_cache?.finalSuggestions || []).map((s) => ({
        title: s.title,
        priority: s.priority,
        rationale: s.rationale || '',
        reasoning: s.reasoning || '',
      }));
      const { ok, data } = await postJSON('/api/program-manager', {
        mode: 'chat',
        channelName: channel.name,
        niche: channel.niche || '',
        editorialNotes: channel.editorialNotes || '',
        creativeOverride: channel.prompt_overrides?.programManager || null,
        existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || v.topic || '' })),
        recentSuggestions,
        messages: history.map((m) => ({ role: m.role, content: m.text })),
      });
      if (!ok) throw new Error(data.error || 'Content Program Manager chat request failed');
      const { text: replyText, proposal } = splitReply(data.reply || '');
      setMessages((prev) => [...prev, { role: 'assistant', text: replyText, proposal, applied: false }]);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSending(false);
    }
  }

  async function applyProposal(index) {
    const msg = messages[index];
    if (!msg?.proposal || applyingIndex !== null) return;
    setApplyingIndex(index);
    try {
      await onApplyUpdate(msg.proposal);
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, applied: true } : m)));
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: '✅ Applied — this is now your creative direction for future suggestions.', proposal: null },
      ]);
    } catch (err) {
      setError(`Could not apply the update: ${String(err.message || err)}`);
    } finally {
      setApplyingIndex(null);
    }
  }

  function onInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...card,
          width: '100%',
          maxWidth: 640,
          height: 'min(720px, 90vh)',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div style={label}>💬 Talk to your Content Manager</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
              Ask why it suggested something, push back on its priorities, or agree on a change to how it should operate — if you two land on
              something concrete, it'll propose an updated creative direction you can apply here.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
              <div
                style={{
                  maxWidth: '85%',
                  background: m.role === 'user' ? T.primaryLight : T.surface,
                  border: `1px solid ${m.role === 'user' ? T.primaryBorder : T.border}`,
                  borderRadius: 8,
                  padding: '10px 14px',
                  fontFamily: FONT.ui,
                  fontSize: 13,
                  color: T.text,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {m.text}
              </div>
              {m.proposal && (
                <div
                  style={{
                    maxWidth: '85%',
                    background: '#FFFFFF',
                    border: `1px solid ${T.primaryBorder}`,
                    borderRadius: 8,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: T.primary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Proposed creative direction update
                  </div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {m.proposal}
                  </div>
                  <button
                    onClick={() => applyProposal(i)}
                    disabled={m.applied || applyingIndex !== null}
                    style={{ ...btnPrimary, alignSelf: 'flex-start', opacity: m.applied || applyingIndex !== null ? 0.6 : 1 }}
                  >
                    {m.applied ? '✅ Applied' : applyingIndex === i ? 'Applying…' : '✅ Apply this update'}
                  </button>
                </div>
              )}
            </div>
          ))}
          {sending && <div style={{ ...mono, fontSize: 11, color: T.textMuted }}>Thinking…</div>}
          {error && <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.primary }}>{error}</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, padding: 16, borderTop: `1px solid ${T.border}` }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Ask about a suggestion, or agree on a change…"
            rows={2}
            style={{ ...inputStyle, flex: 1, resize: 'none' }}
            autoFocus
          />
          <button onClick={send} disabled={sending || !input.trim()} style={{ ...btnPrimary, opacity: sending || !input.trim() ? 0.6 : 1 }}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
