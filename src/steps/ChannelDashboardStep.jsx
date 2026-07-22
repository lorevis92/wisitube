import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import {
  listVideosByChannel,
  deleteVideo,
  loadChannel,
  saveChannel,
  deleteChannel,
  clearYoutubeConnection,
  getCostsByChannel,
  savePromptVersion,
  listPromptVersions,
} from '../lib/db';
import { getMediaUrl } from '../lib/mediaStorage';
import { listChannelPlaylists } from '../lib/youtubePublishEngine';
import { DEFAULT_CREATIVE_DIRECTION, SCHEMA_INSTRUCTIONS_DISPLAY } from '../lib/promptDefaults';

const PROMPT_STAGES = [
  { key: 'titles', stageLabel: 'Titles & Angles' },
  { key: 'outline', stageLabel: 'Outline & Structure' },
  { key: 'scenes', stageLabel: 'Scene Writing' },
  { key: 'programManager', stageLabel: 'Content Program Manager' },
];

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`;
  const year = Math.floor(month / 12);
  return `${year} year${year === 1 ? '' : 's'} ago`;
}

function priorityColor(p) {
  if (p === 'high') return T.primary;
  if (p === 'medium') return T.yellow;
  return T.textMuted;
}

export default function ChannelDashboardStep({ channelId, onResume, onNewVideo, onBack, onChannelChange, onStartVideoFromSuggestion, isMobile }) {
  const [channel, setChannel] = useState(null);
  const [notes, setNotes] = useState('');
  const [videos, setVideos] = useState(null); // null = still loading
  const [thumbUrls, setThumbUrls] = useState({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [refiningIndex, setRefiningIndex] = useState(null);
  const [refineText, setRefineText] = useState('');
  const [totalSpent, setTotalSpent] = useState(0);
  const [showPromptLab, setShowPromptLab] = useState(false);
  // Local in-progress edits per stage, keyed by stage — undefined means "not yet touched this
  // session, fall back to channel.prompt_overrides[stage] or the stage's default text". Kept
  // separate from channel state so typing doesn't need a round-trip through saveChannel on every
  // keystroke; onBlur is what persists.
  const [promptDrafts, setPromptDrafts] = useState({});
  // Which stage's version-history dropdown is open (null = none), plus that dropdown's own loading
  // state and fetched items — refetched every time it's opened rather than cached, so a restore
  // made moments ago always shows up.
  const [historyOpenStage, setHistoryOpenStage] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  // Read-only playlist panel — fetched on demand (button click) rather than on mount, since it's
  // one more YouTube API round-trip that most dashboard visits don't need.
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlists, setPlaylists] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ch, list, costs] = await Promise.all([loadChannel(channelId), listVideosByChannel(channelId), getCostsByChannel(channelId)]);
      if (cancelled) return;
      setChannel(ch || null);
      setNotes(ch?.editorialNotes || '');
      // App.jsx holds the single source of truth for "the currently open channel" — every load and
      // every local mutation below reports here, so components that never do their own fetch (like
      // ExportStep) can't end up looking at a stale copy of e.g. the YouTube connection state.
      onChannelChange?.(ch || null);
      setVideos(list);
      setTotalSpent(costs.total);
      // Phase 3: the Blob itself never survives a reload (see stripBlobsForSync, src/lib/db.js) —
      // storagePath is the Supabase Storage backup, sign a short-lived URL to preview it. Videos
      // that never reached image generation (or whose backup failed) have no storagePath, and
      // keep the "No preview" placeholder.
      const urls = {};
      for (const v of list) {
        const storagePath = v.scenes?.[0]?.images?.[0]?.storagePath;
        if (!storagePath) continue;
        try {
          urls[v.id] = await getMediaUrl(storagePath);
        } catch (err) {
          console.error('[getMediaUrl] failed to sign video preview thumbnail', storagePath, err);
        }
      }
      if (cancelled) return;
      setThumbUrls(urls);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function saveNotes() {
    if (!channel || notes === (channel.editorialNotes || '')) return;
    const updated = await saveChannel({ ...channel, editorialNotes: notes });
    setChannel(updated);
    onChannelChange?.(updated);
  }

  // Persists one stage's creative-direction override — an empty/whitespace-only value, or a value
  // that exactly matches the stage's default text (the textarea's un-overridden starting value,
  // now real editable text rather than a placeholder — see PROMPT_STAGES.map below), both collapse
  // to "no override" rather than storing the default text back as if it were a custom one.
  async function savePromptOverride(stage, value) {
    if (!channel) return;
    const trimmed = (value || '').trim();
    const isDefaultText = trimmed === (DEFAULT_CREATIVE_DIRECTION[stage] || '').trim();
    const effectiveNext = isDefaultText ? '' : trimmed;
    const current = channel.prompt_overrides?.[stage] || '';
    if (effectiveNext === current) return;
    const nextOverrides = { ...(channel.prompt_overrides || {}) };
    if (effectiveNext) nextOverrides[stage] = effectiveNext;
    else delete nextOverrides[stage];
    const [updated] = await Promise.all([
      saveChannel({ ...channel, prompt_overrides: nextOverrides }),
      // Only real custom content is worth a version entry — reverting to the default (or clearing)
      // isn't a "version" of anything, and savePromptVersion no-ops on an empty string anyway.
      effectiveNext ? savePromptVersion(channel.id, stage, effectiveNext) : Promise.resolve(null),
    ]);
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function toggleHistory(stage) {
    if (historyOpenStage === stage) {
      setHistoryOpenStage(null);
      return;
    }
    setHistoryOpenStage(stage);
    setHistoryLoading(true);
    try {
      const items = await listPromptVersions(channel.id, stage);
      setHistoryItems(items);
    } finally {
      setHistoryLoading(false);
    }
  }

  // Restoring is a plain save through the same path every other edit takes — it becomes a new
  // version entry itself (assuming it differs from whatever's most recent), no special-casing.
  async function restoreVersion(stage, content) {
    setPromptDrafts((d) => ({ ...d, [stage]: content }));
    await savePromptOverride(stage, content);
    setHistoryOpenStage(null);
  }

  // Refining never edits a single suggestion — it relaunches the whole holistic pass with the
  // extra instruction folded in, replacing the entire list at once.
  async function fetchSuggestions(refinementText) {
    if (!channel) return;
    setSuggestionsLoading(true);
    setSuggestionsError('');
    try {
      // Enrichment, not a required step — listChannelPlaylists already swallows its own failures
      // and returns [] rather than throwing, so this never blocks getting suggestions.
      const existingPlaylists = await listChannelPlaylists(channel);
      const res = await fetch('/api/program-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: channel.name,
          niche: channel.niche || '',
          editorialNotes: channel.editorialNotes || '',
          existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
          refinement: refinementText || '',
          creativeOverride: channel.prompt_overrides?.programManager || null,
          existingPlaylists,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate suggestions');
      const lastSuggestions = { analysis: data.analysis || '', suggestions: data.suggestions || [], generatedAt: Date.now() };
      const updated = await saveChannel({ ...channel, lastSuggestions });
      setChannel(updated);
      onChannelChange?.(updated);
      setRefiningIndex(null);
      setRefineText('');
    } catch (e) {
      setSuggestionsError(String(e.message || e));
    } finally {
      setSuggestionsLoading(false);
    }
  }

  async function togglePlaylists() {
    if (playlistsOpen) {
      setPlaylistsOpen(false);
      return;
    }
    setPlaylistsOpen(true);
    setPlaylistsLoading(true);
    try {
      const list = await listChannelPlaylists(channel);
      setPlaylists(list);
    } finally {
      setPlaylistsLoading(false);
    }
  }

  async function handleConnectYoutube() {
    try {
      const res = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auth-url', channelId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the YouTube connection');
      window.location.href = data.authUrl;
    } catch (e) {
      window.alert(String(e.message || e));
    }
  }

  async function handleDisconnectYoutube() {
    if (!window.confirm('Disconnect this channel from YouTube?')) return;
    const updated = await clearYoutubeConnection(channelId);
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function handleDeleteChannel() {
    if (!window.confirm(`Delete "${channel?.name || 'this channel'}"? This also deletes all ${videos?.length || 0} of its videos and cannot be undone.`)) return;
    await deleteChannel(channelId);
    onBack();
  }

  async function handleDeleteVideo(id) {
    if (!window.confirm('Delete this video? This cannot be undone.')) return;
    await deleteVideo(id);
    setVideos((list) => list.filter((v) => v.id !== id));
  }

  if (videos === null) {
    return <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>Loading your videos…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: FONT.display, fontSize: 24, color: T.text }}>{channel?.name || 'Channel'}</div>
            {channel?.niche && <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginTop: 4 }}>{channel.niche}</div>}
            <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>💰 ${totalSpent.toFixed(2)} spent on this channel</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onBack} style={btnGhost}>
              ← All channels
            </button>
            <button onClick={handleDeleteChannel} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
              Delete channel
            </button>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={label}>Editorial notes</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={saveNotes}
            placeholder="Tone, recurring formats, things to avoid…"
            rows={2}
            style={{ ...inputStyle, marginTop: 8, resize: 'vertical' }}
          />
        </div>

        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            marginTop: 16,
            paddingTop: 16,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div>
            <div style={label}>YouTube</div>
            {channel?.youtube_connected ? (
              <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 6 }}>
                ✓ Connected to {channel.youtube_channel_name || 'YouTube channel'}
              </div>
            ) : (
              <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
                Connect this channel's YouTube account to enable direct upload.
              </div>
            )}
          </div>
          {channel?.youtube_connected ? (
            <button onClick={handleDisconnectYoutube} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
              Disconnect
            </button>
          ) : (
            <button onClick={handleConnectYoutube} style={btnPrimary}>
              Connect YouTube channel
            </button>
          )}
        </div>

        {channel?.youtube_connected && (
          <div style={{ marginTop: 12 }}>
            <button onClick={togglePlaylists} style={{ ...btnGhost, padding: '6px 12px', fontSize: 11 }}>
              📂 {playlistsOpen ? 'Hide' : 'View'} channel playlists
            </button>
            {playlistsOpen && (
              <div style={{ marginTop: 10, border: `1px solid ${T.border}`, borderRadius: 4, padding: 10, maxHeight: 220, overflowY: 'auto' }}>
                {playlistsLoading ? (
                  <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>Loading…</div>
                ) : !playlists || playlists.length === 0 ? (
                  <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>No playlists found on this channel.</div>
                ) : (
                  playlists.map((p, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: '6px 0',
                        borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                        fontSize: 12,
                        fontFamily: FONT.ui,
                        color: T.text,
                      }}
                    >
                      <span>{p.name}</span>
                      <span style={{ ...mono, color: T.textMuted }}>
                        {p.videoCount} video{p.videoCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <button
          onClick={() => setShowPromptLab((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          <span style={label}>Prompt Lab</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {showPromptLab ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>

        {showPromptLab && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>
              Edit the creative direction each AI generation step follows for this channel — tone, editorial priorities, how to write titles, outlines and scenes. The technical output format each step must return is fixed and shown read-only below its editor.
            </div>

            {PROMPT_STAGES.map(({ key, stageLabel }) => {
              // Never blank: an absent/empty override falls back to the stage's default text as a
              // real, immediately-editable value — not a placeholder — so the field always shows
              // exactly what a generation would use right now.
              const draftValue =
                promptDrafts[key] !== undefined ? promptDrafts[key] : channel?.prompt_overrides?.[key] || DEFAULT_CREATIVE_DIRECTION[key];
              const hasOverride = !!(channel?.prompt_overrides?.[key] || '').trim();
              const isHistoryOpen = historyOpenStage === key;
              return (
                <div key={key} style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontFamily: FONT.ui, fontSize: 13, fontWeight: 700, color: T.text }}>{stageLabel}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => toggleHistory(key)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 9 }}>
                        🕐 History
                      </button>
                      {hasOverride && (
                        <button
                          onClick={() => {
                            setPromptDrafts((d) => ({ ...d, [key]: DEFAULT_CREATIVE_DIRECTION[key] }));
                            savePromptOverride(key, '');
                          }}
                          style={{ ...btnGhost, padding: '5px 10px', fontSize: 9 }}
                        >
                          Reset to default
                        </button>
                      )}
                    </div>
                  </div>

                  {isHistoryOpen && (
                    <div
                      style={{
                        marginTop: 8,
                        border: `1px solid ${T.border}`,
                        borderRadius: 4,
                        maxHeight: 220,
                        overflowY: 'auto',
                      }}
                    >
                      {historyLoading ? (
                        <div style={{ padding: 10, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>Loading…</div>
                      ) : historyItems.length === 0 ? (
                        <div style={{ padding: 10, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>
                          No saved versions yet — versions are recorded whenever you edit and leave this field.
                        </div>
                      ) : (
                        historyItems.map((v) => (
                          <div
                            key={v.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 10,
                              padding: 10,
                              borderTop: `1px solid ${T.border}`,
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ ...mono, fontSize: 10, color: T.textMuted }}>{timeAgo(v.createdAt)}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: T.textSecondary,
                                  fontFamily: FONT.ui,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {v.content.slice(0, 60)}
                                {v.content.length > 60 ? '…' : ''}
                              </div>
                            </div>
                            <button
                              onClick={() => restoreVersion(key, v.content)}
                              style={{ ...btnGhost, padding: '5px 10px', fontSize: 9, flexShrink: 0 }}
                            >
                              Restore
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <div
                    style={{
                      marginTop: 8,
                      padding: 10,
                      borderRadius: 4,
                      background: T.surfaceAlt,
                      color: T.textMuted,
                      fontSize: 11,
                      fontFamily: FONT.mono,
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      maxHeight: 140,
                      overflowY: 'auto',
                    }}
                  >
                    <div style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                      Technical format — not editable
                    </div>
                    {SCHEMA_INSTRUCTIONS_DISPLAY[key]}
                  </div>

                  <textarea
                    value={draftValue}
                    onChange={(e) => setPromptDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onBlur={() => savePromptOverride(key, draftValue)}
                    rows={5}
                    style={{ ...inputStyle, marginTop: 10, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={label}>Content Program Manager</div>
            {channel?.lastSuggestions?.generatedAt && (
              <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>generated {timeAgo(channel.lastSuggestions.generatedAt)}</div>
            )}
          </div>
          <button onClick={() => fetchSuggestions('')} disabled={suggestionsLoading} style={{ ...btnPrimary, opacity: suggestionsLoading ? 0.6 : 1 }}>
            {suggestionsLoading ? 'Working…' : channel?.lastSuggestions ? 'Refresh suggestions' : 'Suggest next videos'}
          </button>
        </div>

        {suggestionsLoading && (
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 14 }}>
            Analyzing your channel and researching the niche… ~30-60s
          </div>
        )}

        {suggestionsError && !suggestionsLoading && (
          <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui, marginTop: 14 }}>{suggestionsError}</div>
        )}

        {channel?.lastSuggestions && !suggestionsLoading && (
          <div style={{ marginTop: 16 }}>
            {channel.lastSuggestions.analysis && (
              <div
                style={{
                  fontFamily: FONT.ui,
                  fontSize: 13,
                  color: T.text,
                  lineHeight: 1.6,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                {channel.lastSuggestions.analysis}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {(channel.lastSuggestions.suggestions || []).map((s, i) => (
                <div
                  key={i}
                  style={{
                    border: s.series ? `1px solid ${T.primaryBorder}` : `1px solid ${T.border}`,
                    background: s.series ? T.primaryLight : '#FFFFFF',
                    borderRadius: 4,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        ...mono,
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: priorityColor(s.priority),
                        border: `1px solid ${priorityColor(s.priority)}`,
                        borderRadius: 3,
                        padding: '2px 6px',
                      }}
                    >
                      {s.priority || 'medium'}
                    </span>
                    {s.series && (
                      <span
                        style={{
                          ...mono,
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: T.primary,
                          background: '#FFFFFF',
                          border: `1px solid ${T.primaryBorder}`,
                          borderRadius: 3,
                          padding: '2px 6px',
                        }}
                      >
                        Series: {s.series}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{s.title}</div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>{s.angle}</div>

                  <div style={{ display: 'flex', gap: 6, marginTop: 'auto', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => onStartVideoFromSuggestion?.(s.title, s.series || null)}
                      style={{ ...btnPrimary, flex: 1, padding: '8px 12px', fontSize: 10 }}
                    >
                      Start this video
                    </button>
                    <button
                      onClick={() => setRefiningIndex(refiningIndex === i ? null : i)}
                      style={{ ...btnGhost, padding: '8px 12px', fontSize: 10 }}
                    >
                      Refine
                    </button>
                  </div>

                  {refiningIndex === i && (
                    <div style={{ marginTop: 4, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                      <textarea
                        value={refineText}
                        onChange={(e) => setRefineText(e.target.value)}
                        placeholder='e.g. "more focused on the 90s"'
                        rows={2}
                        style={{ ...inputStyle, fontSize: 12, resize: 'vertical' }}
                        autoFocus
                      />
                      <div style={{ ...mono, fontSize: 10, color: T.textMuted, marginTop: 4 }}>
                        Relaunches the whole suggestion list oriented to this note.
                      </div>
                      <button
                        onClick={() => fetchSuggestions(refineText)}
                        disabled={suggestionsLoading || !refineText.trim()}
                        style={{ ...btnPrimary, marginTop: 6, padding: '8px 12px', fontSize: 10, opacity: refineText.trim() ? 1 : 0.6 }}
                      >
                        Regenerate with this note
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={label}>Videos</div>
        <button onClick={onNewVideo} style={btnGhost}>
          + New video
        </button>
      </div>

      {videos.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>No videos yet</div>
          <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginBottom: 20 }}>
            Start your first video for this channel and it'll show up here automatically, saved on this device.
          </div>
          <button onClick={onNewVideo} style={btnPrimary}>
            + New video
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {videos.map((v) => {
            const sceneCount = v.scenes?.length || 0;
            const readyCount = v.scenes?.filter((s) => s.images?.every((im) => im.status === 'ready') && s.audioStatus === 'ready').length || 0;
            const title = v.displayTitle || 'Untitled video';
            return (
              <div key={v.id} style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div
                  style={{
                    borderRadius: 4,
                    overflow: 'hidden',
                    border: `1px solid ${T.border}`,
                    background: T.surfaceAlt,
                    aspectRatio: '16/9',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {thumbUrls[v.id] ? (
                    <img src={thumbUrls[v.id]} alt={title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>No preview</span>
                  )}
                </div>
                <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{title}</div>
                <div style={{ ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    {sceneCount} scene{sceneCount === 1 ? '' : 's'} · {readyCount}/{sceneCount} ready
                  </span>
                  <span>{timeAgo(v.updatedAt)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                  <button onClick={() => onResume(v)} style={{ ...btnPrimary, flex: 1 }}>
                    Resume
                  </button>
                  <button onClick={() => handleDeleteVideo(v.id)} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
