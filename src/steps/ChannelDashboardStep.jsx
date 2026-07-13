import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { listVideosByChannel, deleteVideo, loadChannel, saveChannel, deleteChannel, clearYoutubeConnection, getCostsByChannel } from '../lib/db';

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
      const urls = {};
      for (const v of list) {
        const blob = v.scenes?.[0]?.images?.[0]?.blob;
        if (blob) urls[v.id] = URL.createObjectURL(blob);
      }
      setThumbUrls(urls);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Object URLs created for thumbnails only make sense for this render pass — release them on unmount.
  useEffect(() => () => Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u)), [thumbUrls]);

  async function saveNotes() {
    if (!channel || notes === (channel.editorialNotes || '')) return;
    const updated = await saveChannel({ ...channel, editorialNotes: notes });
    setChannel(updated);
    onChannelChange?.(updated);
  }

  // Refining never edits a single suggestion — it relaunches the whole holistic pass with the
  // extra instruction folded in, replacing the entire list at once.
  async function fetchSuggestions(refinementText) {
    if (!channel) return;
    setSuggestionsLoading(true);
    setSuggestionsError('');
    try {
      const res = await fetch('/api/program-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: channel.name,
          niche: channel.niche || '',
          editorialNotes: channel.editorialNotes || '',
          existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
          refinement: refinementText || '',
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

  async function handleConnectYoutube() {
    try {
      const res = await fetch('/api/youtube-auth-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
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
            {channel?.youtube?.connected ? (
              <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 6 }}>
                ✓ Connected to {channel.youtube.channelName || 'YouTube channel'}
              </div>
            ) : (
              <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
                Connect this channel's YouTube account to enable direct upload.
              </div>
            )}
          </div>
          {channel?.youtube?.connected ? (
            <button onClick={handleDisconnectYoutube} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
              Disconnect
            </button>
          ) : (
            <button onClick={handleConnectYoutube} style={btnPrimary}>
              Connect YouTube channel
            </button>
          )}
        </div>
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
