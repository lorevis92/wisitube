import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, getPolliToken, setPolliToken } from '../lib/pollinations';
import { PROVIDER_LABELS, priceForImage } from '../lib/imageProviders';
import { VOICE_ENGINE_LABELS, MINIMAX_VOICES } from '../lib/voiceProviders';
import { KOKORO_VOICES, generateSpeech } from '../lib/tts';
import { generateAudio, generateImage } from '../lib/sceneOrchestrator';
import { recordCost } from '../lib/db';
import { getMediaUrl } from '../lib/mediaStorage';
import { TITLES_PHASE_S } from '../lib/estimator';
import FullScreenLoader from '../components/FullScreenLoader';
import ExpandableTextarea from '../components/ExpandableTextarea';

const LANGUAGES = ['English', 'Italiano', 'Español', 'Français', 'Deutsch'];

// Same list as AutomationStep.jsx's own local CONTENT_TYPES const — duplicated rather than
// imported, same controlled-duplication pattern already used elsewhere in this codebase (e.g.
// YOUTUBE_LANGUAGE_CODES in ExportStep.jsx/fullPipelineRecipe.js).
const CONTENT_TYPES = [
  { value: 'full_pipeline', label: 'Full Pipeline (images)' },
  { value: 'static_background', label: 'Static Background — Language Learning' },
];

export default function CreateStep({ settings, setSettings, onTitles, channel, isMobile }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [voiceTest, setVoiceTest] = useState('');
  const [token, setToken] = useState(getPolliToken());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const thumbnailFileInputRef = useRef(null);

  const references = settings.references || [];
  const characterHints = settings.characterHints || [];
  const mainCharacter = characterHints[0] || { name: '', details: '' };
  const otherCharacters = characterHints.slice(1);

  const isStaticBackground = (settings.contentType || 'full_pipeline') === 'static_background';

  const [bgGenPrompt, setBgGenPrompt] = useState('');
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState('');
  const [bgPreviewUrl, setBgPreviewUrl] = useState('');

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  // Seeds this video's background/text-style config from the channel's defaults exactly once —
  // only while nothing has been set here yet, so switching content type back and forth (or a later
  // per-video edit) never gets silently overwritten. Same seed-once guard StoryboardStep.jsx already
  // uses for its own (later, project-scoped) copy of this same seeding logic.
  useEffect(() => {
    if (!isStaticBackground || settings.staticBackground || !channel) return;
    const hasImage = !!channel.automation_static_bg_image_path;
    set('staticBackground', {
      type: hasImage ? 'image' : 'color',
      color: channel.automation_static_bg_color || '#111111',
      imageStoragePath: hasImage ? channel.automation_static_bg_image_path : null,
      blob: null,
    });
    set('staticTextStyle', {
      textColor: channel.automation_static_text_color || '#FFFFFF',
      outline: channel.automation_static_text_outline !== false,
      outlineColor: channel.automation_static_text_outline_color || '#000000',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaticBackground, channel?.id]);

  // Seeds this video's channel-intro toggle from the channel's own default exactly once — same
  // seed-once guard as the staticBackground effect above, so a later per-video override here is
  // never silently clobbered by a channel change.
  useEffect(() => {
    if (settings.channelIntroEnabled !== undefined || !channel) return;
    set('channelIntroEnabled', channel.automation_channel_intro === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id]);

  // Preview for the background image — a freshly picked/generated Blob (not yet uploaded, no
  // videoId exists yet at this step) previews directly via an object URL; an untouched channel
  // default (already durable at its own Storage path) previews via a short-lived signed URL, same
  // pattern as ChannelDashboardStep.jsx's own default-background preview.
  useEffect(() => {
    const bg = settings.staticBackground;
    if (!bg || bg.type !== 'image') {
      setBgPreviewUrl('');
      return;
    }
    if (bg.blob) {
      setBgPreviewUrl(URL.createObjectURL(bg.blob));
      return;
    }
    if (!bg.imageStoragePath) {
      setBgPreviewUrl('');
      return;
    }
    let cancelled = false;
    getMediaUrl(bg.imageStoragePath)
      .then((url) => {
        if (!cancelled) setBgPreviewUrl(url);
      })
      .catch((err) => console.error('[CreateStep] failed to sign background preview', err));
    return () => {
      cancelled = true;
    };
  }, [settings.staticBackground?.imageStoragePath, settings.staticBackground?.blob, settings.staticBackground?.type]);

  function handleUploadStaticBgImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    set('staticBackground', { ...(settings.staticBackground || {}), type: 'image', imageStoragePath: null, blob: file });
  }

  // Same single-still-image gateway StoryboardStep.jsx/ChannelDashboardStep.jsx's own background
  // sections use — one plain generateImage call, no per-scene beats involved. No videoId exists yet
  // at this step, so the result stays an in-memory Blob (uploaded once a real video is created, see
  // App.jsx's handleOutlineReady) — same deferred-upload precedent as reference photos (ExportStep.jsx).
  async function handleGenerateStaticBgImage() {
    const trimmed = bgGenPrompt.trim();
    if (!trimmed) {
      setBgError('Enter a description for the background image.');
      return;
    }
    const provider = settings.imageProvider === 'nanobanana-batch' ? 'nanobanana' : settings.imageProvider || 'pollinations';
    const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
    const cost = priceForImage(provider, { ...dims, quality: 'medium', hasReference: false });
    if (cost > 0 && !window.confirm(`Generate this background image using ${provider} (~$${cost.toFixed(2)})?`)) return;
    setBgBusy(true);
    setBgError('');
    try {
      const { imageUrl, costUsd } = await generateImage(trimmed, provider, [], { ...dims, seed: Math.floor(Math.random() * 999999), quality: 'medium' });
      if (costUsd > 0) await recordCost({ channelId: channel?.id, videoId: null, provider, type: 'image', amountUsd: costUsd });
      const blob = await (await fetch(imageUrl)).blob();
      set('staticBackground', { ...(settings.staticBackground || {}), type: 'image', imageStoragePath: null, blob });
    } catch (err) {
      setBgError('Generation failed: ' + String(err.message || err));
    } finally {
      setBgBusy(false);
    }
  }

  function setBackgroundColor(color) {
    set('staticBackground', { ...(settings.staticBackground || {}), type: 'color', color });
  }

  function removeStaticBgImage() {
    set('staticBackground', { ...(settings.staticBackground || {}), type: 'color', imageStoragePath: null, blob: null });
  }

  function updateTextStyle(patch) {
    set('staticTextStyle', { ...(settings.staticTextStyle || {}), ...patch });
  }

  function handleThumbnailFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    set('manualThumbnailFile', file);
    set('manualThumbnailPreviewUrl', URL.createObjectURL(file));
  }

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
      let blob;
      const speed = Number(settings.speechSpeed) || 1.0;
      if ((settings.voiceEngine || 'kokoro') === 'minimax') {
        const { audioUrl } = await generateAudio('Hi! This is the voice that will narrate your video.', settings.voice, { language: settings.language, speed });
        blob = await (await fetch(audioUrl)).blob();
      } else {
        blob = await generateSpeech('Hi! This is the voice that will narrate your video.', settings.voice, speed);
      }
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
          creativeOverride: channel?.prompt_overrides?.titles || null,
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
        <ExpandableTextarea
          value={settings.topic}
          onChange={(e) => set('topic', e.target.value)}
          placeholder='e.g. "Why the Roman Empire never really fell" or "5 psychology tricks stores use on you"'
          rows={3}
          style={{ ...inputStyle, marginTop: 10, resize: 'vertical' }}
        />

        <div style={fieldGrid}>
          <div>
            <div style={label}>Content type</div>
            <select
              value={settings.contentType || 'full_pipeline'}
              onChange={(e) => set('contentType', e.target.value)}
              style={{ ...inputStyle, marginTop: 8 }}
            >
              {CONTENT_TYPES.map((ct) => (
                <option key={ct.value} value={ct.value}>
                  {ct.label}
                </option>
              ))}
            </select>
          </div>
          {!isStaticBackground && (
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
          )}
          <div>
            <div style={label}>Image engine</div>
            {isStaticBackground && (
              <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: FONT.ui, margin: '4px 0 4px', lineHeight: 1.4 }}>
                Used only for generating the background image and/or thumbnail, if you choose AI generation below.
              </div>
            )}
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
            <div style={label}>Voice engine</div>
            <select
              value={settings.voiceEngine || 'kokoro'}
              onChange={(e) => {
                const engine = e.target.value;
                set('voiceEngine', engine);
                set('voice', engine === 'minimax' ? MINIMAX_VOICES[0].id : 'af_heart');
              }}
              style={{ ...inputStyle, marginTop: 8 }}
            >
              {Object.entries(VOICE_ENGINE_LABELS).map(([id, engineLabel]) => (
                <option key={id} value={id}>
                  {engineLabel}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={label}>Voice</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <select value={settings.voice} onChange={(e) => set('voice', e.target.value)} style={inputStyle}>
                {(settings.voiceEngine || 'kokoro') === 'minimax'
                  ? MINIMAX_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))
                  : Object.entries(KOKORO_VOICES).map(([group, voices]) => (
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
              <div style={label}>Speech speed</div>
              <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{(Number(settings.speechSpeed) || 1.0).toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0.7"
              max="1.2"
              step="0.05"
              value={Number(settings.speechSpeed) || 1.0}
              onChange={(e) => set('speechSpeed', Number(e.target.value))}
              style={{ width: '100%', marginTop: 10 }}
            />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={label}>Video length</div>
              {!settings.aiDecidesLength && (
                <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 700 }}>
                  {settings.lengthMinutes || 5} minute{(settings.lengthMinutes || 5) === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {settings.aiDecidesLength ? (
              <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 8, lineHeight: 1.5 }}>
                The AI will choose a length that fits the topic naturally, avoiding padding or rushed cuts.
              </div>
            ) : (
              <>
                <input
                  type="range"
                  min="1"
                  max="25"
                  step="1"
                  value={settings.lengthMinutes || 5}
                  onChange={(e) => set('lengthMinutes', Number(e.target.value))}
                  style={{ width: '100%', marginTop: 10 }}
                />
                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
                  This sets the content density, not an exact runtime — actual video length varies based on how the script naturally
                  unfolds (typically 1.5-2.5× the target).
                </div>
              </>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
              <input
                type="checkbox"
                checked={!!settings.aiDecidesLength}
                onChange={(e) => set('aiDecidesLength', e.target.checked)}
              />
              Let AI decide the ideal length
            </label>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={
                (settings.channelIntroEnabled !== undefined ? settings.channelIntroEnabled : channel?.automation_channel_intro) === true
              }
              onChange={(e) => set('channelIntroEnabled', e.target.checked)}
            />
            Include channel intro at video start
          </label>
          <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
            Pre-filled from this channel's default — override it for just this video here. When enabled, the video
            opens with a brief welcome that introduces the channel's purpose (using its Niche description).
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
            <ExpandableTextarea
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
                  <ExpandableTextarea
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
            <ExpandableTextarea
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

        {isStaticBackground && (
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 24, paddingTop: 16 }}>
            <div style={label}>Background</div>
            <div style={{ fontSize: 12, color: T.textSecondary, margin: '6px 0 10px', fontFamily: FONT.ui }}>
              Pre-filled from this channel's defaults — change it here just for this video.
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                Solid color
                <input
                  type="color"
                  value={settings.staticBackground?.color || '#111111'}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                />
              </label>
            </div>

            {bgPreviewUrl && settings.staticBackground?.type === 'image' && (
              <>
                <img
                  src={bgPreviewUrl}
                  alt="Background"
                  style={{ width: '100%', maxWidth: 280, borderRadius: 4, border: `1px solid ${T.border}`, marginTop: 10, display: 'block' }}
                />
                <button onClick={removeStaticBgImage} style={{ ...btnGhost, marginTop: 8, padding: '6px 10px', fontSize: 11 }}>
                  ✕ Remove image
                </button>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ ...btnGhost, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                Upload image
                <input type="file" accept="image/*" onChange={handleUploadStaticBgImage} style={{ display: 'none' }} />
              </label>
              <input
                value={bgGenPrompt}
                onChange={(e) => setBgGenPrompt(e.target.value)}
                placeholder="…or describe an image to generate"
                style={{ ...inputStyle, flex: 1, minWidth: 180 }}
              />
              <button onClick={handleGenerateStaticBgImage} disabled={bgBusy} style={{ ...btnPrimary, opacity: bgBusy ? 0.6 : 1 }}>
                {bgBusy ? 'Working…' : 'Generate'}
              </button>
            </div>
            {bgError && <div style={{ marginTop: 8, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{bgError}</div>}

            <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
              <div style={label}>Text style</div>
              <div style={{ display: 'flex', gap: 18, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                  Text color
                  <input
                    type="color"
                    value={settings.staticTextStyle?.textColor || '#FFFFFF'}
                    onChange={(e) => updateTextStyle({ textColor: e.target.value })}
                    style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                  <input
                    type="checkbox"
                    checked={settings.staticTextStyle?.outline !== false}
                    onChange={(e) => updateTextStyle({ outline: e.target.checked })}
                  />
                  Outline
                </label>
                {settings.staticTextStyle?.outline !== false && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                    Outline color
                    <input
                      type="color"
                      value={settings.staticTextStyle?.outlineColor || '#000000'}
                      onChange={(e) => updateTextStyle({ outlineColor: e.target.value })}
                      style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                    />
                  </label>
                )}
              </div>
            </div>

            <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
              <div style={label}>Thumbnail</div>
              <div style={{ fontSize: 12, color: T.textSecondary, margin: '6px 0 10px', fontFamily: FONT.ui }}>
                Choose how this video's YouTube thumbnail will be created.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => set('thumbnailMode', 'ai')}
                  style={(settings.thumbnailMode || 'ai') === 'ai' ? btnPrimary : btnGhost}
                >
                  Generate with AI
                </button>
                <button onClick={() => set('thumbnailMode', 'manual')} style={settings.thumbnailMode === 'manual' ? btnPrimary : btnGhost}>
                  Upload manually
                </button>
              </div>
              {settings.thumbnailMode === 'manual' ? (
                <div style={{ marginTop: 10 }}>
                  {settings.manualThumbnailPreviewUrl && (
                    <img
                      src={settings.manualThumbnailPreviewUrl}
                      alt="Thumbnail"
                      style={{ width: '100%', maxWidth: 280, borderRadius: 4, border: `1px solid ${T.border}`, marginBottom: 8, display: 'block' }}
                    />
                  )}
                  <input ref={thumbnailFileInputRef} type="file" accept="image/*" onChange={handleThumbnailFile} style={{ display: 'none' }} />
                  <button onClick={() => thumbnailFileInputRef.current?.click()} style={btnGhost}>
                    {settings.manualThumbnailFile ? 'Change image' : 'Choose image'}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 8, fontFamily: FONT.ui, lineHeight: 1.5 }}>
                  Uses {PROVIDER_LABELS[settings.imageProvider || 'pollinations']} (the Image engine selected above) to generate a
                  thumbnail concept later, in Export.
                </div>
              )}
            </div>
          </div>
        )}

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
