import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { listChannels, listVideosByChannel, saveChannel, createId, getTotalCostAllChannels } from '../lib/db';
import { getMediaUrl } from '../lib/mediaStorage';
import ExpandableTextarea from '../components/ExpandableTextarea';

export default function ChannelsListStep({ onOpenChannel, isMobile }) {
  const [channels, setChannels] = useState(null); // null = still loading
  const [videoCounts, setVideoCounts] = useState({});
  const [thumbUrls, setThumbUrls] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', niche: '', editorialNotes: '' });
  const [totalSpent, setTotalSpent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, total] = await Promise.all([listChannels(), getTotalCostAllChannels()]);
      if (cancelled) return;
      setChannels(list);
      setTotalSpent(total);
      const counts = {};
      const urls = {};
      for (const c of list) {
        const videos = await listVideosByChannel(c.id);
        if (cancelled) return;
        counts[c.id] = videos.length;
        // Phase 3: the Blob itself never survives a reload (see stripBlobsForSync, src/lib/db.js)
        // — storagePath is the Supabase Storage backup, sign a short-lived URL to preview it. The
        // most recent video's own thumbnail (generated to be representative of the whole video —
        // see thumbnailEngine.js) wins over its first scene's first image whenever one exists,
        // regardless of content_type: a thumbnail is a deliberate choice, a first scene image is
        // just whatever happened to be scene 1. Videos that never reached either (or whose backup
        // failed) have no storagePath, and keep the "No preview" placeholder.
        const storagePath = videos[0]?.thumbnailStoragePath || videos[0]?.scenes?.[0]?.images?.[0]?.storagePath;
        if (storagePath) {
          try {
            urls[c.id] = await getMediaUrl(storagePath);
          } catch (err) {
            console.error('[getMediaUrl] failed to sign channel preview thumbnail', storagePath, err);
          }
        }
      }
      if (cancelled) return;
      setVideoCounts(counts);
      setThumbUrls(urls);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function createChannel() {
    if (!form.name.trim()) return;
    const channel = await saveChannel({
      id: createId(),
      name: form.name.trim(),
      niche: form.niche.trim(),
      editorialNotes: form.editorialNotes.trim(),
      createdAt: Date.now(),
    });
    setShowForm(false);
    setForm({ name: '', niche: '', editorialNotes: '' });
    onOpenChannel(channel);
  }

  if (channels === null) {
    return <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>Loading your channels…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Static external links only — no API calls, so there's no error state to handle here. */}
      <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={label}>Check your balances</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a
            href="https://fal.ai/dashboard/billing"
            target="_blank"
            rel="noreferrer"
            style={{ ...btnGhost, textDecoration: 'none', display: 'inline-block' }}
          >
            💰 fal.ai balance →
          </a>
          <a
            href="https://console.cloud.google.com/billing"
            target="_blank"
            rel="noreferrer"
            style={{ ...btnGhost, textDecoration: 'none', display: 'inline-block' }}
          >
            💰 Google Cloud billing →
          </a>
        </div>
        <div style={{ ...mono, fontSize: 11, color: T.textMuted }}>May require one extra click to select the right billing account/project</div>
      </div>

      <div style={{ ...mono, fontSize: 12, color: T.textSecondary }}>
        💰 Total spent across all channels: ${totalSpent.toFixed(2)}
      </div>
      <div style={label}>Your channels</div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {channels.map((c) => (
          <div
            key={c.id}
            onClick={() => onOpenChannel(c)}
            style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, cursor: 'pointer' }}
          >
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
              {thumbUrls[c.id] ? (
                <img src={thumbUrls[c.id]} alt={c.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>No preview</span>
              )}
            </div>
            <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{c.name}</div>
            {c.niche && <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary }}>{c.niche}</div>}
            <div style={{ ...mono, fontSize: 11, color: T.textMuted }}>
              {videoCounts[c.id] || 0} video{(videoCounts[c.id] || 0) === 1 ? '' : 's'}
            </div>
          </div>
        ))}

        {showForm ? (
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Channel name"
              style={inputStyle}
              autoFocus
            />
            <ExpandableTextarea
              value={form.niche}
              onChange={(e) => setForm((f) => ({ ...f, niche: e.target.value }))}
              placeholder="Niche (optional)"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <ExpandableTextarea
              value={form.editorialNotes}
              onChange={(e) => setForm((f) => ({ ...f, editorialNotes: e.target.value }))}
              placeholder="Editorial notes (optional)"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={createChannel} disabled={!form.name.trim()} style={{ ...btnPrimary, flex: 1, opacity: form.name.trim() ? 1 : 0.6 }}>
                Create
              </button>
              <button onClick={() => setShowForm(false)} style={btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => setShowForm(true)}
            style={{
              ...card,
              padding: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 148,
              color: T.textSecondary,
              fontFamily: FONT.ui,
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              border: `1px dashed ${T.border}`,
            }}
          >
            + New channel
          </div>
        )}
      </div>
    </div>
  );
}
