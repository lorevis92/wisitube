import React, { useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, getPolliToken, setPolliToken } from '../lib/pollinations';
import { PROVIDER_LABELS } from '../lib/imageProviders';
import { KOKORO_VOICES, generateSpeech } from '../lib/tts';
import { TITLES_PHASE_S } from '../lib/estimator';
import FullScreenLoader from '../components/FullScreenLoader';

const LANGUAGES = ['English', 'Italiano', 'Español', 'Français', 'Deutsch'];

export default function CreateStep({ settings, setSettings, onTitles, isMobile }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [voiceTest, setVoiceTest] = useState('');
  const [token, setToken] = useState(getPolliToken());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);

  const references = settings.references || [];
  const characterHints = settings.characterHints || [];
  const mainCharacter = characterHints[0] || { name: '', details: '' };
  const otherCharacters = characterHints.slice(1);

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const updateReference = (id, patch) =>
    setSettings((s) => ({
      ...s,
      references: (s.references || []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));

  const removeReference = (id) =>
    setSettings((s) => ({ ...s, references: (s.references || []).filter((r) => r.id !== id) }));

  const updateMainCharacter = (patch) =>
    setSettings((s) => {
      const hints = [...(s.characterHints || [])];
      hints[0] = { ...(hints[0] || { name: '', details: '' }), ...patch };
      return { ...s, characterHints: hints };
    });

  const updateOtherCharacter = (idx, patch) =>
    setSettings((s) => {
      const hints = [...(s.characterHints || [])];
      hints[idx + 1] = { ...(hints[idx + 1] || { name: '', details: '' }), ...patch };
      return { ...s, characterHints: hints };
    });

  const addOtherCharacter = () =>
    setSettings((s) => {
      const hints = [...(s.characterHints || [])];
      if (hints.length < 1) hints.push({ name: '', details: '' });
      hints.push({ name: '', details: '' });
      return { ...s, characterHints: hints };
    });

  const removeOtherCharacter = (idx) =>
    setSettings((s) => {
      const hints = [...(s.characterHints || [])];
      hints.splice(idx + 1, 1);
      return { ...s, characterHints: hints };
    });

  function handleReferenceFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;
    const ref = {
      id: crypto.randomUUID(),
      label: '',
      file,
      previewUrl: URL.createObjectURL(file),
    };
    setSettings((s) => ({ ...s, references: [...(s.references || []), ref] }));
  }

  async function testVoice() {
    if (voiceTest === settings.voice) return;
    setVoiceTest(settings.voice);
    try {
      const blob = await generateSpeech('Hi! This is the voice that will narrate your video.', settings.voice);
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
      const res = await fetch('/api/generate-titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: settings.topic.trim(),
          language: settings.language,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      onTitles(data.titles || []);
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
            <div style={label}>Image engine</div>
            <select
              value={settings.imageProvider || 'pollinations'}
              onChange={(e) => set('imageProvider', e.target.value)}
              style={{ ...inputStyle, marginTop: 8 }}
            >
              {Object.entries(PROVIDER_LABELS).map(([id, providerLabel]) => (
                <option key={id} value={id}>
                  {providerLabel}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={label}>Voice</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <select value={settings.voice} onChange={(e) => set('voice', e.target.value)} style={inputStyle}>
                {Object.entries(KOKORO_VOICES).map(([group, voices]) => (
                  <optgroup key={group} label={group}>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button onClick={testVoice} style={{ ...btnGhost, padding: '10px 14px', whiteSpace: 'nowrap' }}>
                {voiceTest ? '…' : '▶ Test'}
              </button>
            </div>
            <audio ref={audioRef} style={{ display: 'none' }} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={label}>Video length</div>
              <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 700 }}>
                {settings.lengthMinutes || 5} minute{(settings.lengthMinutes || 5) === 1 ? '' : 's'}
              </span>
            </div>
            <input
              type="range"
              min="1"
              max="25"
              step="1"
              value={settings.lengthMinutes || 5}
              onChange={(e) => set('lengthMinutes', Number(e.target.value))}
              style={{ width: '100%', marginTop: 10 }}
            />
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

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 24, paddingTop: 16 }}>
          <div style={label}>Video details (optional)</div>
          <div style={{ fontSize: 12, color: T.textSecondary, margin: '6px 0 14px', fontFamily: FONT.ui }}>
            Help Claude keep characters and tone consistent across scenes — everything here is optional, leave it
            blank to let it improvise.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textSecondary, fontFamily: FONT.ui, marginBottom: 6 }}>
              Main character
            </div>
            <input
              value={mainCharacter.name}
              onChange={(e) => updateMainCharacter({ name: e.target.value })}
              placeholder="Name, e.g. Napoleon Bonaparte"
              style={{ ...inputStyle, marginBottom: 6 }}
            />
            <textarea
              value={mainCharacter.details}
              onChange={(e) => updateMainCharacter({ details: e.target.value })}
              placeholder="Physical details (optional — leave blank and Claude will infer them for well-known figures)"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: T.textSecondary, fontFamily: FONT.ui, marginBottom: 6 }}>
            Other key characters
          </div>
          {otherCharacters.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
              {otherCharacters.map((c, idx) => (
                <div key={idx} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      value={c.name}
                      onChange={(e) => updateOtherCharacter(idx, { name: e.target.value })}
                      placeholder="Name"
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button onClick={() => removeOtherCharacter(idx)} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                      ✕
                    </button>
                  </div>
                  <textarea
                    value={c.details}
                    onChange={(e) => updateOtherCharacter(idx, { details: e.target.value })}
                    placeholder="Physical details (optional — leave blank and Claude will infer them for well-known figures)"
                    rows={2}
                    style={{ ...inputStyle, resize: 'vertical' }}
                  />
                </div>
              ))}
            </div>
          )}
          <button onClick={addOtherCharacter} style={btnGhost}>
            + Add character
          </button>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textSecondary, fontFamily: FONT.ui, marginBottom: 6 }}>
              General notes
            </div>
            <textarea
              value={settings.generalNotes || ''}
              onChange={(e) => set('generalNotes', e.target.value)}
              placeholder="Tone, setting, recurring objects or motifs…"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 24, paddingTop: 16 }}>
          <div style={label}>Reference photos (optional)</div>
          <div style={{ fontSize: 12, color: T.textSecondary, margin: '6px 0 10px', fontFamily: FONT.ui }}>
            Upload a photo and label it (e.g. "Young Agassi, long hair") — Claude will match it to the right scenes
            automatically and use it to anchor those images to the real subject. The photo is sent to WisiTube's
            server in a single step at generation time, so there's nothing to configure here.
          </div>

          {references.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
              {references.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', border: `1px solid ${T.border}`, borderRadius: 4, padding: 8 }}>
                  <img src={r.previewUrl} alt={r.label || 'reference'} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 3, border: `1px solid ${T.border}`, flexShrink: 0 }} />
                  <input
                    value={r.label}
                    onChange={(e) => updateReference(r.id, { label: e.target.value })}
                    placeholder='Label, e.g. "Young Agassi, long hair"'
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={() => removeReference(r.id)} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleReferenceFile} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} style={btnGhost}>
            + Add reference photo
          </button>
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
                Normal images (Flux, generated directly from your browser) use the free, anonymous Pollinations.ai
                tier and need no token — this only raises the rate limit if you hit it (voiceover runs locally via
                Kokoro TTS and never needs one either). Reference photos work automatically through WisiTube's own
                server and don't use this token at all. Get a free one at{' '}
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
        {loading ? 'Working…' : 'Get title ideas →'}
      </button>

      {loading && (
        <FullScreenLoader
          title="Writing title options…"
          subtitle="Claude is coming up with 5 clickable angles for your topic"
          estimatedSeconds={TITLES_PHASE_S}
        />
      )}
    </div>
  );
}
