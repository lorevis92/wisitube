import React from 'react';
import { T, FONT, mono } from '../theme';
import { formatDuration } from '../lib/estimator';

export default function FullScreenLoader({ estimatedSeconds }) {
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
        <div style={{ fontFamily: FONT.display, fontSize: 24, color: T.text }}>Setting up your storyboard…</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 14, color: T.textSecondary, marginTop: 10 }}>
          Claude is writing your script, titles and thumbnail ideas
        </div>

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
