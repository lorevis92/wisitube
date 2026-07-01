import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { loadImage, decodeAudio } from '../lib/pollinations';
import { playTimeline, ANIMATION_LIST } from '../lib/engine';

export default function EditorStep({ project, setProject, settings, onExport, isMobile }) {
  const canvasRef = useRef(null);
  const controllerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [selected, setSelected] = useState(0);
  const [subtitles, setSubtitles] = useState(project.subtitles);
  const [error, setError] = useState('');

  const scenes = project.scenes;
  const dims = settings.format === '9:16' ? { W: 720, H: 1280 } : { W: 1280, H: 720 };
  const durations = scenes.map((s) => (s.audioDuration || 0) + s.pad);
  const total = durations.reduce((a, b) => a + b, 0);

  useEffect(() => () => controllerRef.current?.stop(), []);

  useEffect(() => {
    setProject((p) => ({ ...p, subtitles }));
  }, [subtitles, setProject]);

  async function buildItems(fromIdx = 0) {
    const slice = scenes.slice(fromIdx);
    return Promise.all(
      slice.map(async (s) => ({
        img: await loadImage(s.imageUrl),
        buffer: await decodeAudio(s.audioUrl),
        duration: (s.audioDuration || 0) + s.pad,
        narration: s.narration,
        animation: s.animation,
      }))
    );
  }

  async function play(fromIdx = 0) {
    stop();
    setError('');
    try {
      const items = await buildItems(fromIdx);
      const offset = durations.slice(0, fromIdx).reduce((a, b) => a + b, 0);
      setPlaying(true);
      controllerRef.current = await playTimeline({
        canvas: canvasRef.current,
        items,
        subtitles,
        onProgress: (t, _tot, idx) => {
          setTime(offset + t);
          setActiveIdx(fromIdx + idx);
        },
        onDone: () => {
          setPlaying(false);
          setActiveIdx(-1);
        },
      });
    } catch (e) {
      setPlaying(false);
      setError('Preview failed: ' + String(e.message || e));
    }
  }

  function stop() {
    controllerRef.current?.stop();
    controllerRef.current = null;
    setPlaying(false);
  }

  const updateScene = (id, patch) =>
    setProject((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const move = (idx, dir) => {
    setProject((p) => {
      const arr = [...p.scenes];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return p;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...p, scenes: arr };
    });
    setSelected((s) => Math.min(Math.max(s + dir, 0), scenes.length - 1));
  };

  const remove = (idx) => {
    if (scenes.length <= 2) return;
    setProject((p) => ({ ...p, scenes: p.scenes.filter((_, i) => i !== idx) }));
    setSelected((s) => Math.max(0, Math.min(s, scenes.length - 2)));
  };

  const sel = scenes[selected];
  const playheadPct = total > 0 ? Math.min(100, (time / total) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Preview */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={label}>4 · Preview & fine-tune</div>
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary }}>
            {time.toFixed(1)}s / {total.toFixed(1)}s
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            background: '#000',
            borderRadius: 4,
            overflow: 'hidden',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <canvas
            ref={canvasRef}
            width={dims.W}
            height={dims.H}
            style={{
              width: settings.format === '9:16' ? 'auto' : '100%',
              height: settings.format === '9:16' ? (isMobile ? 420 : 520) : 'auto',
              maxWidth: '100%',
              display: 'block',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {playing ? (
            <button onClick={stop} style={btnGhost}>
              ■ Stop
            </button>
          ) : (
            <>
              <button onClick={() => play(0)} style={btnPrimary}>
                ▶ Play all
              </button>
              <button onClick={() => play(selected)} style={btnGhost}>
                ▶ From scene {selected + 1}
              </button>
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase', color: T.textSecondary, marginLeft: 'auto' }}>
            <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />
            Subtitles
          </label>
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{error}</div>}
      </div>

      {/* Timeline */}
      <div style={{ ...card, padding: 16 }}>
        <div style={label}>Timeline</div>
        <div style={{ position: 'relative', marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 2, height: 64, borderRadius: 4, overflow: 'hidden', border: `1px solid ${T.border}` }}>
            {scenes.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setSelected(i)}
                title={`Scene ${i + 1} · ${durations[i].toFixed(1)}s`}
                style={{
                  flexGrow: Math.max(durations[i], 0.5),
                  flexBasis: 0,
                  minWidth: 14,
                  padding: 0,
                  border: 'none',
                  borderRight: `1px solid ${T.border}`,
                  outline: i === selected ? `2px solid ${T.primary}` : 'none',
                  outlineOffset: -2,
                  backgroundImage: s.imageUrl ? `url(${s.imageUrl})` : 'none',
                  backgroundColor: T.surfaceAlt,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  opacity: activeIdx === i ? 1 : 0.85,
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    bottom: 2,
                    left: 4,
                    ...mono,
                    fontSize: 10,
                    color: '#FFF',
                    textShadow: '0 0 3px rgba(0,0,0,0.9)',
                  }}
                >
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
          {playing && (
            <div
              style={{
                position: 'absolute',
                top: -4,
                bottom: -4,
                left: `${playheadPct}%`,
                width: 2,
                background: T.primary,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Selected scene controls */}
        {sel && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ ...label, color: T.text }}>
                Scene <span style={mono}>{String(selected + 1).padStart(2, '0')}</span>
                <span style={{ ...mono, color: T.textMuted, marginLeft: 8, textTransform: 'none', fontWeight: 400 }}>
                  voice {sel.audioDuration?.toFixed(1)}s + pause {sel.pad.toFixed(1)}s
                </span>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => move(selected, -1)} disabled={selected === 0} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                  ← Move
                </button>
                <button onClick={() => move(selected, 1)} disabled={selected === scenes.length - 1} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                  Move →
                </button>
                <button onClick={() => remove(selected)} disabled={scenes.length <= 2} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, color: T.primary, borderColor: T.primaryBorder }}>
                  ✕ Delete
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginTop: 12 }}>
              <div>
                <div style={label}>Extra pause after voice: <span style={mono}>{sel.pad.toFixed(1)}s</span></div>
                <input
                  type="range"
                  min="0"
                  max="2.5"
                  step="0.1"
                  value={sel.pad}
                  onChange={(e) => updateScene(sel.id, { pad: parseFloat(e.target.value) })}
                  style={{ width: '100%', marginTop: 8 }}
                />
              </div>
              <div>
                <div style={label}>Animation</div>
                <select value={sel.animation} onChange={(e) => updateScene(sel.id, { animation: e.target.value })} style={{ ...inputStyle, marginTop: 8 }}>
                  {ANIMATION_LIST.map((a) => (
                    <option key={a} value={a}>
                      {a.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      <button onClick={onExport} style={{ ...btnPrimary, padding: '14px 20px', fontSize: 13 }}>
        Looks good — go to export →
      </button>
    </div>
  );
}
