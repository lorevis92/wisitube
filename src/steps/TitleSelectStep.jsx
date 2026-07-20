import React, { useState } from 'react';
import { T, FONT, card, label, btnGhost } from '../theme';
import { STYLES } from '../lib/pollinations';
import { estimateTotalSeconds, estimateScenesChunkSeconds } from '../lib/estimator';
import { isModelWarm } from '../lib/tts';
import FullScreenLoader from '../components/FullScreenLoader';

export default function TitleSelectStep({ titleOptions, settings, onOutlineReady, onBack, channel }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function choose(option) {
    setError('');
    setLoading(true);
    try {
      const references = (settings.references || []).filter((r) => r.label.trim()).map((r) => ({ id: r.id, label: r.label }));
      const characterHints = (settings.characterHints || [])
        .filter((c) => c && (c.name?.trim() || c.details?.trim()))
        .map((c) => ({ name: (c.name || '').trim(), details: (c.details || '').trim() }));

      const res = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: settings.topic.trim(),
          title: option.title,
          angle: option.angle,
          language: settings.language,
          lengthMinutes: settings.lengthMinutes,
          style: STYLES[settings.style].label,
          imageProvider: settings.imageProvider,
          characterHints,
          generalNotes: (settings.generalNotes || '').trim(),
          references,
          creativeOverride: channel?.prompt_overrides?.outline || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Outline generation failed');
      onOutlineReady(data, option.title, option.angle);
    } catch (e) {
      setError(String(e.message || e));
      setLoading(false);
    }
  }

  // Scene-writing hasn't started yet at this point — that portion of the estimate is shown again,
  // more accurately (with a real progress bar), once it actually begins.
  const estimate = Math.max(
    0,
    estimateTotalSeconds({ lengthMinutes: settings.lengthMinutes, modelWarm: isModelWarm() }) -
      estimateScenesChunkSeconds(settings.lengthMinutes)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={label}>2 · Pick your title</div>
          {onBack && (
            <button onClick={onBack} disabled={loading} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: loading ? 0.6 : 1 }}>
              ← Back
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {(titleOptions || []).map((opt, i) => (
            <button
              key={i}
              onClick={() => choose(opt)}
              disabled={loading}
              style={{
                textAlign: 'left',
                padding: '12px 14px',
                borderRadius: 4,
                border: `1px solid ${T.border}`,
                background: '#FFFFFF',
                cursor: loading ? 'default' : 'pointer',
                opacity: loading ? 0.6 : 1,
              }}
            >
              <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text }}>{opt.title}</div>
              <div style={{ fontFamily: FONT.ui, fontSize: 12, fontStyle: 'italic', color: T.textSecondary, marginTop: 4 }}>
                {opt.angle}
              </div>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ ...card, borderColor: T.primaryBorder, background: T.primaryLight, padding: 14, fontSize: 13, color: T.primary, fontFamily: FONT.ui }}>
          {error}
        </div>
      )}

      {loading && (
        <FullScreenLoader
          title="Planning your video's structure…"
          subtitle="Claude is researching your topic and building the chapter outline"
          estimatedSeconds={estimate}
        />
      )}
    </div>
  );
}
