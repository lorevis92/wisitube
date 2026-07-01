import React, { useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, VOICES, fetchTTS, getPolliToken, setPolliToken } from '../lib/pollinations';

const LENGTHS = [
  { id: 'short', label: 'Short · ~60s' },
  { id: 'medium', label: 'Medium · 2-3 min' },
  { id: 'long', label: 'Long · 4-5 min' },
];

const LANGUAGES = ['English', 'Italiano', 'Español', 'Français', 'Deutsch'];

export default function CreateStep({ settings, setSettings, onPlan, isMobile }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [voiceTest, setVoiceTest] = useState('');
  const [token, setToken] = useState(getPolliToken());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const audioRef = useRef(null);

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  async function testVoice() {
    if (voiceTest === settings.voice) return;
    setVoiceTest(settings.voice);
    try {
      const blob = await fetchTTS('Hi! This is the voice that will narrate your video.', settings.voice, { retries: 0 });
      if (audioRef.current) {
        audioRef.current.src = URL.createObjectURL(blob);
        audioRef.current.play();
      }
    } catch {
      setError('Voice preview unavailable right now — generation will still work.');
    } finally {
      setVoiceTest('');
    }
  }

  async function generate() {
    if (!settings.topic.trim()) {
      setError('Enter a topic first.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: settings.topic.trim(),
          language: settings.language,
          length: settings.length,
          format: settings.format,
          style: STYLES[settings.style].label,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      onPlan(data);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  const fieldGrid = {
    display: 'grid',
    gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
    gap: 16,
    marginTop: 20,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={card}>
        <div style={label}>1 · What is your video about?</div>
        <textarea
          value={settings.topic}
          onChange={(e) => set('topic', e.target.value)}
          placeholder='e.g. "Why the Roman Empire never really fell" or "5 psychology tricks stores use on you"'
          rows={3}
          style={{ ...inputStyle, marginTop: 10, resize: 'vertical' }}
        />

        <div style={fieldGrid}>
          <div>
            <div style={label}>Visual style</div>
            <select value={settings.style} onChange={(e) => set('style', e.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
              {Object.entries(STYLES).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={label}>Voice</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <select value={settings.voice} onChange={(e) => set('voice', e.target.value)} style={inputStyle}>
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <button onClick={testVoice} style={{ ...btnGhost, padding: '10px 14px', whiteSpace: 'nowrap' }}>
                {voiceTest ? '…' : '▶ Test'}
              </button>
            </div>
            <audio ref={audioRef} style={{ display: 'none' }} />
          </div>
          <div>
            <div style={label}>Length</div>
            <select value={settings.length} onChange={(e) => set('length', e.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
              {LENGTHS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={label}>Format</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {['16:9', '9:16'].map((f) => (
                <button
                  key={f}
                  onClick={() => set('format', f)}
                  style={{
                    ...(settings.format === f ? btnPrimary : btnGhost),
                    flex: 1,
                    ...mono,
                    textTransform: 'none',
                  }}
                >
                  {f} {f === '16:9' ? '· Video' : '· Shorts'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={label}>Narration language</div>
            <select value={settings.language} onChange={(e) => set('language', e.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 24, paddingTop: 12 }}>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}
          >
            Advanced {showAdvanced ? 'CLOSE ▲' : 'SHOW ▼'}
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 12 }}>
              <div style={label}>Pollinations token (optional)</div>
              <div style={{ fontSize: 12, color: T.textSecondary, margin: '6px 0 8px', fontFamily: FONT.ui }}>
                Images and voiceover use the free Pollinations.ai tier. If you hit rate limits, get a free token at{' '}
                <a href="https://enter.pollinations.ai" target="_blank" rel="noreferrer" style={{ color: T.primary }}>
                  enter.pollinations.ai
                </a>{' '}
                and paste it here (saved locally in your browser).
              </div>
              <input
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setPolliToken(e.target.value);
                }}
                placeholder="token…"
                style={{ ...inputStyle, ...mono }}
              />
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ ...card, borderColor: T.primaryBorder, background: T.primaryLight, padding: 14, fontSize: 13, color: T.primary, fontFamily: FONT.ui }}>
          {error}
        </div>
      )}

      <button onClick={generate} disabled={loading} style={{ ...btnPrimary, padding: '14px 20px', fontSize: 13, opacity: loading ? 0.7 : 1 }}>
        {loading ? 'Writing script, titles & storyboard…' : 'Generate video plan →'}
      </button>
      {loading && (
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'center', fontFamily: FONT.ui, animation: 'wisiPulse 1.6s infinite' }}>
          Claude is writing your hook, scenes and SEO pack — about 20 seconds
        </div>
      )}
    </div>
  );
}
