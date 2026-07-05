import React from 'react';
import { T, FONT, mono } from '../theme';
import { formatDuration } from '../lib/estimator';

export default function FullScreenLoader({
  title = 'Setting up your storyboard…',
  subtitle = 'Claude is writing your script, titles and thumbnail ideas',
  estimatedSeconds,
  note,
  progress,
}) {
  const hasProgress = progress && Number.isFinite(progress.total) && progress.total > 0;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <div
          style={{
            width: 34,
            height: 34,
            margin: '0 auto 22px',
            borderRadius: '50%',
            border: `3px solid ${T.border}`,
            borderTopColor: T.primary,
            animation: 'wisiSpin 0.9s linear infinite',
          }}
        />
        <div style={{ fontFamily: FONT.display, fontSize: 24, color: T.text }}>{title}</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 14, color: T.textSecondary, marginTop: 10 }}>{subtitle}</div>

        {note && (
          <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textMuted, marginTop: 8 }}>{note}</div>
        )}

        {hasProgress && (
          <div style={{ marginTop: 20 }}>
            <div style={{ height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden', border: `1px solid ${T.border}` }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, (progress.current / progress.total) * 100)}%`,
                  background: T.primary,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 8 }}>
              {progress.current} / {progress.total} scenes
            </div>
          </div>
        )}

        {Number.isFinite(estimatedSeconds) && (
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${T.border}` }}>
            <div style={{ ...mono, fontSize: 13, color: T.text, fontWeight: 700 }}>
              Estimated total time to finish this video: ~{formatDuration(estimatedSeconds)}
            </div>
          </div>
        )}

        <div style={{ fontFamily: FONT.ui, fontSize: 11, color: T.textMuted, marginTop: 18, lineHeight: 1.5 }}>
          Once your images and voiceover start generating, you can leave this tab — everything continues automatically.
        </div>
      </div>
    </div>
  );
}
