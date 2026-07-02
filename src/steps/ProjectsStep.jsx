import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, mono } from '../theme';
import { listProjects, deleteProject } from '../lib/db';

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

export default function ProjectsStep({ onResume, onNewProject, isMobile }) {
  const [projects, setProjects] = useState(null); // null = still loading
  const [thumbUrls, setThumbUrls] = useState({});

  useEffect(() => {
    let cancelled = false;
    listProjects().then((list) => {
      if (cancelled) return;
      setProjects(list);
      const urls = {};
      for (const p of list) {
        const blob = p.scenes?.[0]?.imageBlob;
        if (blob) urls[p.id] = URL.createObjectURL(blob);
      }
      setThumbUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Object URLs created for thumbnails only make sense for this render pass — release them on unmount.
  useEffect(() => () => Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u)), [thumbUrls]);

  async function handleDelete(id) {
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    await deleteProject(id);
    setProjects((list) => list.filter((p) => p.id !== id));
  }

  if (projects === null) {
    return <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>Loading your projects…</div>;
  }

  if (projects.length === 0) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: 40 }}>
        <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>No projects yet</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginBottom: 20 }}>
          Start your first video and it'll show up here automatically, saved on this device.
        </div>
        <button onClick={onNewProject} style={btnPrimary}>
          + New project
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={label}>Your projects</div>
        <button onClick={onNewProject} style={btnGhost}>
          + New project
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {projects.map((p) => {
          const sceneCount = p.scenes?.length || 0;
          const readyCount = p.scenes?.filter((s) => s.imageStatus === 'ready' && s.audioStatus === 'ready').length || 0;
          const title = p.topic || p.titles?.[0] || 'Untitled project';
          return (
            <div key={p.id} style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                {thumbUrls[p.id] ? (
                  <img src={thumbUrls[p.id]} alt={title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>No preview</span>
                )}
              </div>
              <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{title}</div>
              <div style={{ ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {sceneCount} scene{sceneCount === 1 ? '' : 's'} · {readyCount}/{sceneCount} ready
                </span>
                <span>{timeAgo(p.updatedAt)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                <button onClick={() => onResume(p)} style={{ ...btnPrimary, flex: 1 }}>
                  Resume
                </button>
                <button onClick={() => handleDelete(p.id)} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
