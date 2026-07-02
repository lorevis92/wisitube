import React, { useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, buildImageUrl, loadImage, decodeAudio } from '../lib/pollinations';
import { generateSpeech, onLoadProgress } from '../lib/tts';
import { ANIMATION_LIST } from '../lib/engine';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function StoryboardStep({ project, setProject, settings, onReady, isMobile }) {
  const [running, setRunning] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showSeo, setShowSeo] = useState(false);

  const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };

  const updateScene = (id, patch) =>
    setProject((p) => ({
      ...p,
      scenes: p.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const fullPrompt = (scene) =>
    `${scene.imagePrompt}, ${STYLES[settings.style].suffix}, no text, no letters, no words in the image`;

  async function genImage(scene, newSeed = false) {
    const seed = newSeed ? Math.floor(Math.random() * 999999) : scene.seed;
    const url = buildImageUrl(fullPrompt(scene), { ...dims, seed });
    updateScene(scene.id, { imageStatus: 'loading', seed });
    try {
      await loadImage(url);
      // Keep the raw bytes so the project survives without the remote URL (persistence, offline).
      const imageBlob = await (await fetch(url)).blob();
      const imageUrl = URL.createObjectURL(imageBlob);
      updateScene(scene.id, { imageStatus: 'ready', imageUrl, imageBlob });
      return true;
    } catch {
      updateScene(scene.id, { imageStatus: 'error' });
      return false;
    }
  }

  async function genAudio(scene) {
    updateScene(scene.id, { audioStatus: 'loading', audioError: null });
    try {
      const audioBlob = await generateSpeech(scene.narration, settings.voice);
      const audioUrl = URL.createObjectURL(audioBlob);
      const buffer = await decodeAudio(audioUrl);
      updateScene(scene.id, { audioStatus: 'ready', audioUrl, audioBlob, audioDuration: buffer.duration, audioError: null });
      return true;
    } catch (e) {
      updateScene(scene.id, { audioStatus: 'error', audioError: e?.message || String(e) });
      return false;
    }
  }

  async function generateAll() {
    setRunning(true);
    const scenes = project.scenes;

    const unsubscribe = onLoadProgress((info) => {
      if (info.status === 'progress') {
        setProgressMsg(`Downloading voice model (~90MB, one time)… ${Math.round(info.progress)}%`);
      }
    });

    // Interleave image + voice per scene — Kokoro runs locally with no rate limit, so only the
    // Pollinations image call needs spacing out.
    let imageCallsMade = 0;
    try {
      for (let i = 0; i < scenes.length; i++) {
        const scene = project.scenes.find((s) => s.id === scenes[i].id) || scenes[i];
        if (scene.imageStatus !== 'ready') {
          if (imageCallsMade > 0) await sleep(1500);
          setProgressMsg(`Scene ${i + 1} of ${scenes.length}: image…`);
          await genImage(scene);
          imageCallsMade++;
        }

        const sceneAfterImage = project.scenes.find((s) => s.id === scenes[i].id) || scene;
        if (sceneAfterImage.audioStatus !== 'ready') {
          setProgressMsg(`Scene ${i + 1} of ${scenes.length}: voice…`);
          await genAudio(sceneAfterImage);
        }
      }
    } finally {
      unsubscribe();
    }

    setProgressMsg('');
    setRunning(false);
  }

  const readyCount = project.scenes.filter((s) => s.imageStatus === 'ready' && s.audioStatus === 'ready').length;
  const allReady = readyCount === project.scenes.length;
  const totalSec = project.scenes.reduce((a, s) => a + (s.audioDuration || 0) + s.pad, 0);

  const statusDot = (st, title) => (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 8,
        background: st === 'ready' ? T.green : st === 'error' ? T.primary : st === 'loading' ? T.yellow : T.border,
        animation: st === 'loading' ? 'wisiPulse 1.2s infinite' : 'none',
      }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Titles */}
      <div style={card}>
        <div style={label}>2 · Pick your title</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {project.titles.map((t, i) => {
            const active = i === project.selectedTitle;
            return (
              <button
                key={i}
                onClick={() => setProject((p) => ({ ...p, selectedTitle: i }))}
                style={{
                  textAlign: 'left',
                  padding: '11px 14px',
                  borderRadius: 4,
                  border: `1px solid ${active ? T.primary : T.border}`,
                  background: active ? T.primaryLight : '#FFFFFF',
                  color: T.text,
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  fontFamily: FONT.ui,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 18, paddingTop: 10 }}>
          <button
            onClick={() => setShowSeo((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}
          >
            Description & Tags {showSeo ? 'CLOSE ▲' : 'SHOW ▼'}
          </button>
          {showSeo && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, color: T.textSecondary, whiteSpace: 'pre-wrap', fontFamily: FONT.ui }}>{project.description}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {project.tags.map((tag, i) => (
                  <span key={i} style={{ ...mono, fontSize: 11, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 3, padding: '3px 8px', color: T.textSecondary }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Generation control */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={label}>3 · Generate images & voiceover</div>
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
            {readyCount}/{project.scenes.length} scenes ready
            {totalSec > 0 && ` · ~${Math.round(totalSec)}s of video`}
            {progressMsg && ` · ${progressMsg}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={generateAll} disabled={running || allReady} style={{ ...btnPrimary, opacity: running || allReady ? 0.6 : 1 }}>
            {running ? 'Generating…' : allReady ? 'All ready ✓' : readyCount > 0 ? 'Generate missing' : 'Generate all media'}
          </button>
          {allReady && (
            <button onClick={onReady} style={btnPrimary}>
              Open editor →
            </button>
          )}
        </div>
      </div>

      {/* Scenes */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        {project.scenes.map((scene, i) => (
          <div key={scene.id} style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ ...label, color: T.text }}>
                Scene <span style={mono}>{String(i + 1).padStart(2, '0')}</span>
              </span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{statusDot(scene.imageStatus)} img</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{statusDot(scene.audioStatus, scene.audioStatus === 'error' ? scene.audioError : undefined)} voice</span>
                {scene.audioDuration ? <span style={mono}>{scene.audioDuration.toFixed(1)}s</span> : null}
              </span>
            </div>

            <div
              style={{
                marginTop: 10,
                borderRadius: 4,
                overflow: 'hidden',
                border: `1px solid ${T.border}`,
                background: T.surfaceAlt,
                aspectRatio: settings.format === '9:16' ? '9/16' : '16/9',
                maxHeight: settings.format === '9:16' ? 260 : undefined,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {scene.imageStatus === 'ready' ? (
                <img src={scene.imageUrl} alt={`Scene ${i + 1}`} crossOrigin="anonymous" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase', animation: scene.imageStatus === 'loading' ? 'wisiPulse 1.2s infinite' : 'none' }}>
                  {scene.imageStatus === 'loading' ? 'Drawing…' : scene.imageStatus === 'error' ? 'Failed — retry' : 'Not generated'}
                </span>
              )}
            </div>

            <textarea
              value={scene.narration}
              onChange={(e) => updateScene(scene.id, { narration: e.target.value, audioStatus: 'idle', audioDuration: 0 })}
              rows={2}
              style={{ ...inputStyle, marginTop: 10, fontSize: 12, resize: 'vertical' }}
            />
            <textarea
              value={scene.imagePrompt}
              onChange={(e) => updateScene(scene.id, { imagePrompt: e.target.value, imageStatus: 'idle' })}
              rows={2}
              style={{ ...inputStyle, marginTop: 6, fontSize: 11, color: T.textSecondary, resize: 'vertical' }}
              title="Image prompt (English)"
            />

            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => genImage(scene, true)} disabled={running} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                ↻ Image
              </button>
              <button onClick={() => genAudio(scene)} disabled={running} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                ↻ Voice
              </button>
              {scene.audioUrl && (
                <button onClick={() => new Audio(scene.audioUrl).play()} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                  ▶ Listen
                </button>
              )}
              <select
                value={scene.animation}
                onChange={(e) => updateScene(scene.id, { animation: e.target.value })}
                style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 10, marginLeft: 'auto' }}
              >
                {ANIMATION_LIST.map((a) => (
                  <option key={a} value={a}>
                    {a.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
