import React from 'react';
import { T, FONT, card, label, mono } from '../theme';

// Read-only mirror of whatever the automation engine is doing right now (see App.jsx's
// currentAutomationRun, fed by AutomationStep.jsx's onRunUpdate). No generation/regeneration
// controls live here on purpose — this view never touches project/setProject, so it can never
// contend for state with the manual Create/Storyboard/Editor/Export screens, which stay free for
// hand-editing a *different* video on a *different* channel while this runs in the background.
const PHASE_LABELS = {
  starting: 'Starting run',
  suggestion: 'Choosing a topic',
  'video-record': 'Creating video record',
  outline: 'Writing outline',
  scenes: 'Writing scenes',
  media: 'Generating images & voiceover',
  render: 'Rendering video',
  thumbnail: 'Creating thumbnail',
  youtube: 'Publishing to YouTube',
};

const LOG_PHASES = new Set(['starting', 'suggestion', 'video-record', 'outline', 'scenes']);

// Same status-dot logic as StoryboardStep.jsx's own statusDot, minus the title tooltip (there's no
// error text worth surfacing here since this view has no retry button to act on it anyway).
function statusDot(st) {
  return (
    <span
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
}

export default function AutomationMirrorStep({ run, isMobile }) {
  if (!run) {
    return (
      <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>
        No automation run is currently active.
      </div>
    );
  }

  const { channelName, phase, phaseDetail, project, log = [] } = run;
  const phaseLabel = PHASE_LABELS[phase] || phase || '—';
  const renderPct = phase === 'render' ? parseInt(phaseDetail, 10) || 0 : 0;
  // Driven by observed state (project.pendingImageBatches), not channel config this view has no
  // access to — as soon as the media phase has actually submitted a Gemini Batch job for this
  // video, this is true; before that first submission (or for every other provider) it's false and
  // the ordinary per-scene grid below renders instead.
  const isBatchMode = phase === 'media' && (project?.pendingImageBatches || []).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{ fontFamily: FONT.display, fontSize: 26, color: T.text }}>Automation — live view</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginTop: 6, lineHeight: 1.6, maxWidth: 640 }}>
          Read-only mirror of the automated run currently in progress on <strong>{channelName}</strong>. Nothing here can be edited or
          regenerated — Create, Storyboard, Editor and Export remain free for manual work on other channels while this keeps running in
          the background.
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={label}>Current phase</div>
          <span style={{ ...mono, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: T.primary }}>{phaseLabel}</span>
        </div>
        {phaseDetail && <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 8 }}>{phaseDetail}</div>}
      </div>

      {phase === 'render' && (
        <div style={card}>
          <div style={label}>Render progress</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${renderPct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
            </div>
            <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{renderPct}%</span>
          </div>
        </div>
      )}

      {isBatchMode && project?.scenes && (() => {
        const allBeats = project.scenes.flatMap((s, sceneIdx) => (s.images || []).map((im, beatIndex) => ({ ...im, sceneIdx, beatIndex })));
        const readyBeats = allBeats.filter((b) => b.status === 'ready');
        const pct = allBeats.length ? Math.round((readyBeats.length / allBeats.length) * 100) : 0;
        return (
          <div style={card}>
            <div style={label}>Gemini Batch — images in progress</div>
            <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 10 }}>
              {readyBeats.length} of {allBeats.length} images ready — batch jobs in progress, may take up to a few hours
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
              </div>
              <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{pct}%</span>
            </div>
            {readyBeats.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={label}>Ready so far</div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? 'repeat(auto-fill, minmax(80px, 1fr))' : 'repeat(auto-fill, minmax(110px, 1fr))',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {readyBeats.map((b) => (
                    <img
                      key={b.id}
                      src={b.url}
                      alt=""
                      style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', borderRadius: 4, border: `1px solid ${T.border}` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {phase === 'media' && project?.scenes && !isBatchMode && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
          {project.scenes.map((scene, i) => (
            <div key={scene.id} style={{ ...card, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...label, color: T.text }}>
                  Scene <span style={mono}>{String(i + 1).padStart(2, '0')}</span>
                </span>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>
                  {(scene.images || []).map((im, b) => (
                    <span key={im.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {statusDot(im.status)} img{b + 1}
                    </span>
                  ))}
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {statusDot(scene.audioStatus)} voice
                  </span>
                  {scene.audioDuration ? <span style={mono}>{scene.audioDuration.toFixed(1)}s</span> : null}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                {(scene.images || []).map((beat, b) => (
                  <div
                    key={beat.id}
                    style={{
                      position: 'relative',
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
                    {beat.status === 'ready' && beat.url ? (
                      <img src={beat.url} alt={`Scene ${i + 1} · beat ${b + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span
                        style={{
                          fontSize: 10,
                          color: T.textMuted,
                          fontFamily: FONT.ui,
                          textTransform: 'uppercase',
                          textAlign: 'center',
                          padding: 4,
                          animation: beat.status === 'loading' ? 'wisiPulse 1.2s infinite' : 'none',
                        }}
                      >
                        {beat.status === 'loading' ? 'Drawing…' : beat.status === 'error' ? 'Failed' : `Beat ${b + 1}`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {LOG_PHASES.has(phase) && log.length > 0 && (
        <div style={card}>
          <div style={label}>Live log</div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {log
              .slice()
              .reverse()
              .map((entry, i) => (
                <div key={i} style={{ ...mono, fontSize: 12, color: T.textSecondary }}>
                  <span style={{ color: T.textMuted }}>{PHASE_LABELS[entry.phase] || entry.phase}:</span> {entry.message}
                </div>
              ))}
          </div>
        </div>
      )}

      {(phase === 'thumbnail' || phase === 'youtube') && (
        <div style={card}>
          <div style={label}>{phaseLabel}</div>
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 8 }}>{phaseDetail || 'In progress…'}</div>
        </div>
      )}
    </div>
  );
}
