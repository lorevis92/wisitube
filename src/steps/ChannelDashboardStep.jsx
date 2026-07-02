import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { listVideosByChannel, deleteVideo, loadChannel, saveChannel, deleteChannel } from '../lib/db';

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

export default function ChannelDashboardStep({ channelId, onResume, onNewVideo, onBack, onChannelLoaded, isMobile }) {
  const [channel, setChannel] = useState(null);
  const [notes, setNotes] = useState('');
  const [videos, setVideos] = useState(null); // null = still loading
  const [thumbUrls, setThumbUrls] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ch, list] = await Promise.all([loadChannel(channelId), listVideosByChannel(channelId)]);
      if (cancelled) return;
      setChannel(ch || null);
      setNotes(ch?.editorialNotes || '');
      onChannelLoaded?.(ch);
      setVideos(list);
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
