import React, { useMemo, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, loadImage, decodeAudio } from '../lib/pollinations';
import { generateSpeech, onLoadProgress, isModelWarm } from '../lib/tts';
import { acquireWakeLock, releaseWakeLock } from '../lib/wakeLock';
import { recordImageTime, recordAudioTime, estimateRemainingSeconds, formatDuration } from '../lib/estimator';
import { ANIMATION_LIST } from '../lib/engine';
import { generateImage } from '../lib/sceneOrchestrator';
import { buildTelegraphicPrompt, buildNaturalLanguagePrompt } from '../lib/promptBuilders';
import { priceForImage, PROVIDER_LABELS } from '../lib/imageProviders';
import ImageLightbox from '../components/ImageLightbox';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Array.isArray/length guard: projects saved before the 2-image-beat model lack `images`
// entirely — treat those as not-ready rather than crashing on scenes.every() over undefined.
const isSceneReady = (s) =>
  Array.isArray(s.images) && s.images.length > 0 && s.images.every((im) => im.status === 'ready') && s.audioStatus === 'ready';

export default function StoryboardStep({ project, setProject, settings, onReady, isMobile }) {
  const [running, setRunning] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showSeo, setShowSeo] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [costConfirm, setCostConfirm] = useState(null); // { provider, count, total } | null

  const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };

  const updateScene = (id, patch) =>
    setProject((p) => ({
      ...p,
      scenes: p.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const updateImage = (sceneId, beatIndex, patch) =>
    setProject((p) => ({
      ...p,
      scenes: p.scenes.map((s) =>
        s.id === sceneId ? { ...s, images: s.images.map((im, i) => (i === beatIndex ? { ...im, ...patch } : im)) } : s
      ),
    }));

  const updateCharacter = (id, patch) =>
    setProject((p) => ({
      ...p,
      characterBible: (p.characterBible || []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));

  const updateVariant = (charId, variantIdx, patch) =>
    setProject((p) => ({
      ...p,
      characterBible: (p.characterBible || []).map((c) =>
        c.id === charId ? { ...c, variants: c.variants.map((v, i) => (i === variantIdx ? { ...v, ...patch } : v)) } : c
      ),
    }));

  const addVariant = (charId) =>
    setProject((p) => ({
      ...p,
      characterBible: (p.characterBible || []).map((c) =>
        c.id === charId ? { ...c, variants: [...(c.variants || []), { label: '', description: '' }] } : c
      ),
    }));

  // Reference photos (a real face) always win over the text-only character bible for the same
  // beat — the bible's traits are appended only when there's no active photo anchoring this beat.
  // Pollinations gets the compact, telegraphic style (its model needs unambiguous fragments);
  // Nano Banana 2 / GPT Image 2 get full natural-language sentences, with the character's name
  // used as an explicit semantic anchor when one applies.
  function fullPrompt(beat) {
    const hasReference = !!(beat.referenceId && (project.references || []).some((r) => r.id === beat.referenceId));
    let character = null;
    let traits = '';
    if (beat.characterId && !hasReference) {
      character = (project.characterBible || []).find((c) => c.id === beat.characterId);
      const variant = character && (character.variants || []).find((v) => v.label === beat.variantLabel);
      traits = [character?.baseDescription, variant?.description].filter(Boolean).join(', ');
    }

    const styleSuffix = STYLES[settings.style].suffix;
    const provider = settings.imageProvider || 'pollinations';

    if (provider === 'pollinations') {
      return buildTelegraphicPrompt({ scenePrompt: beat.prompt, styleSuffix, characterTraits: traits });
    }
    return buildNaturalLanguagePrompt({ scenePrompt: beat.prompt, styleSuffix, characterName: character?.name, characterTraits: traits });
  }

  async function genImage(sceneId, beatIndex, newSeed = false) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return false;
    const beat = scene.images[beatIndex];
    const seed = newSeed ? Math.floor(Math.random() * 999999) : beat.seed;
    const reference = beat.referenceId ? (project.references || []).find((r) => r.id === beat.referenceId) : null;
    const provider = settings.imageProvider || 'pollinations';
    updateImage(sceneId, beatIndex, { status: 'loading', seed });
    const startedAt = performance.now();
    try {
      // Reference photos flow to every provider the same way now — nanobanana/gptimage take them
      // natively as referenceImages, same principle already used for Pollinations kontext.
      const referenceImages = reference ? [await blobToDataUri(reference.file)] : [];
      const { imageUrl } = await generateImage(fullPrompt(beat), provider, referenceImages, { ...dims, seed, quality: 'medium' });
      await loadImage(imageUrl);
      // Keep the raw bytes so the project survives without the remote URL (persistence, offline).
      const imageBlob = await (await fetch(imageUrl)).blob();
      const objectUrl = URL.createObjectURL(imageBlob);
      recordImageTime((performance.now() - startedAt) / 1000);
      updateImage(sceneId, beatIndex, { status: 'ready', url: objectUrl, blob: imageBlob });
      return true;
    } catch {
      updateImage(sceneId, beatIndex, { status: 'error' });
      return false;
    }
  }

  async function genAudio(scene) {
    updateScene(scene.id, { audioStatus: 'loading', audioError: null });
    const startedAt = performance.now();
    const wasWarmBefore = isModelWarm();
    try {
      const audioBlob = await generateSpeech(scene.narration, settings.voice);
      const audioUrl = URL.createObjectURL(audioBlob);
      const buffer = await decodeAudio(audioUrl);
      // Skip the sample if this call paid the one-time model download/load cost — that's
      // accounted for separately (the +90s term), and would otherwise wreck the moving average.
      if (wasWarmBefore) recordAudioTime((performance.now() - startedAt) / 1000);
      updateScene(scene.id, { audioStatus: 'ready', audioUrl, audioBlob, audioDuration: buffer.duration, audioError: null });
      return true;
    } catch (e) {
      updateScene(scene.id, { audioStatus: 'error', audioError: e?.message || String(e) });
      return false;
    }
  }

  async function generateAll() {
    setRunning(true);
    await acquireWakeLock();
    const scenes = project.scenes;

    const unsubscribe = onLoadProgress((info) => {
      if (info.status === 'progress') {
        setProgressMsg(`Downloading voice model (~90MB, one time)… ${Math.round(info.progress)}%`);
      }
    });

    try {
      // Per scene: voice first, then its two image beats — Kokoro is local (no rate limit), so
      // only the Pollinations image calls need spacing out.
      let imageCallsMade = 0;
      for (let i = 0; i < scenes.length; i++) {
        let scene = project.scenes.find((s) => s.id === scenes[i].id) || scenes[i];

        if (scene.audioStatus !== 'ready') {
          setProgressMsg(`Scene ${i + 1} of ${scenes.length}: voice…`);
          await genAudio(scene);
          scene = project.scenes.find((s) => s.id === scenes[i].id) || scene;
        }

        for (let b = 0; b < scene.images.length; b++) {
          if (scene.images[b].status !== 'ready') {
            if (imageCallsMade > 0) await sleep(1500);
            setProgressMsg(`Scene ${i + 1} of ${scenes.length}: image ${b + 1}/${scene.images.length}…`);
            await genImage(scene.id, b);
            imageCallsMade++;
            scene = project.scenes.find((s) => s.id === scenes[i].id) || scene;
          }
        }
      }
    } finally {
      unsubscribe();
      await releaseWakeLock();
    }

    setProgressMsg('');
    setRunning(false);
  }

  // Paid providers require an explicit confirmation before any billable call goes out — computed
  // from the beats that actually still need generating (not a blind scenes×2 for the whole video),
  // so "Generate missing" on a partially-done video quotes only what will really be charged.
  function pendingBeats() {
    const list = [];
    project.scenes.forEach((s) => s.images.forEach((im) => { if (im.status !== 'ready') list.push(im); }));
    return list;
  }

  function estimateCost(provider) {
    const beats = pendingBeats();
    const total = beats.reduce(
      (sum, beat) => sum + priceForImage(provider, { width: dims.width, height: dims.height, quality: 'medium', hasReference: !!beat.referenceId }),
      0
    );
    return { count: beats.length, total };
  }

  function requestGenerateAll() {
    const provider = settings.imageProvider || 'pollinations';
    if (provider === 'pollinations') {
      generateAll();
      return;
    }
    const { count, total } = estimateCost(provider);
    if (count === 0) {
      generateAll();
      return;
    }
    setCostConfirm({ provider, count, total });
  }

  function confirmGenerateAll() {
    setCostConfirm(null);
    generateAll();
  }

  const readyCount = project.scenes.filter(isSceneReady).length;
  const allReady = readyCount === project.scenes.length;
  const totalSec = project.scenes.reduce((a, s) => a + (s.audioDuration || 0) + s.pad, 0);
  const remainingSeconds = useMemo(() => estimateRemainingSeconds(project.scenes, isModelWarm()), [project.scenes]);

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
      {/* Title — chosen earlier in TitleSelectStep, shown here as a static, non-editable header */}
      <div style={card}>
        <div style={label}>Title</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 18, fontWeight: 700, color: T.text, marginTop: 10, lineHeight: 1.3 }}>
          {project.titles?.[project.selectedTitle] || 'Untitled video'}
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

      {/* Character bible — text-based visual consistency, no photo required */}
      {(project.characterBible || []).length > 0 && (
        <div style={card}>
          <div style={label}>Characters</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
            {project.characterBible.map((c) => (
              <div key={c.id} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: FONT.ui, marginBottom: 8 }}>{c.name}</div>
                <textarea
                  value={c.baseDescription}
                  onChange={(e) => updateCharacter(c.id, { baseDescription: e.target.value })}
                  rows={2}
                  style={{ ...inputStyle, fontSize: 12, resize: 'vertical' }}
                  title="Traits that never change across variants"
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {(c.variants || []).map((v, vi) => (
                    <div key={vi} style={{ display: 'flex', gap: 8, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                      <input
                        value={v.label}
                        onChange={(e) => updateVariant(c.id, vi, { label: e.target.value })}
                        placeholder="e.g. Young Napoleon, 1790s"
                        style={{ ...inputStyle, fontSize: 12, flex: isMobile ? '1 1 100%' : '0 0 180px' }}
                      />
                      <textarea
                        value={v.description}
                        onChange={(e) => updateVariant(c.id, vi, { description: e.target.value })}
                        rows={1}
                        style={{ ...inputStyle, fontSize: 12, flex: 1, resize: 'vertical' }}
                      />
                    </div>
                  ))}
                </div>
                <button onClick={() => addVariant(c.id)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 9, marginTop: 8 }}>
                  + Add variant
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generation control */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={label}>3 · Generate images & voiceover</div>
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
            {readyCount}/{project.scenes.length} scenes ready
            {totalSec > 0 && ` · ~${Math.round(totalSec)}s of video`}
            {progressMsg && ` · ${progressMsg}`}
          </div>
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 4 }}>
            ⏱ Estimated time remaining: {allReady ? 'Done' : formatDuration(remainingSeconds)}
          </div>
          {running && (
            <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
              🔒 Keeping your screen awake while generating
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={requestGenerateAll} disabled={running || allReady} style={{ ...btnPrimary, opacity: running || allReady ? 0.6 : 1 }}>
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
                {scene.images.map((im, b) => (
                  <span key={im.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {statusDot(im.status)} img{b + 1}
                  </span>
                ))}
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{statusDot(scene.audioStatus, scene.audioStatus === 'error' ? scene.audioError : undefined)} voice</span>
                {scene.audioDuration ? <span style={mono}>{scene.audioDuration.toFixed(1)}s</span> : null}
              </span>
            </div>

            {/* Two image beats, side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              {scene.images.map((beat, b) => {
                return (
                  <div key={beat.id}>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                      <select
                        value={beat.referenceId || ''}
                        onChange={(e) => updateImage(scene.id, b, { referenceId: e.target.value || null, status: 'idle' })}
                        style={{ ...inputStyle, flex: 1, padding: '4px 6px', fontSize: 9 }}
                        title="Reference photo to anchor this beat to"
                      >
                        <option value="">— No reference —</option>
                        {(project.references || []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={beat.characterId ? `${beat.characterId}::${beat.variantLabel || ''}` : ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            updateImage(scene.id, b, { characterId: null, variantLabel: null, status: 'idle' });
                            return;
                          }
                          const sep = v.indexOf('::');
                          updateImage(scene.id, b, {
                            characterId: v.slice(0, sep),
                            variantLabel: v.slice(sep + 2) || null,
                            status: 'idle',
                          });
                        }}
                        style={{ ...inputStyle, flex: 1, padding: '4px 6px', fontSize: 9 }}
                        title="Character bible entry to anchor this beat to"
                      >
                        <option value="">— None —</option>
                        {(project.characterBible || []).flatMap((c) =>
                          (c.variants && c.variants.length ? c.variants : [{ label: '' }]).map((v, vi) => (
                            <option key={`${c.id}-${vi}`} value={`${c.id}::${v.label || ''}`}>
                              {c.name}
                              {v.label ? ` — ${v.label}` : ''}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div
                      style={{
                        position: 'relative',
                        borderRadius: 4,
                        overflow: 'hidden',
                        border: `1px solid ${T.border}`,
                        background: T.surfaceAlt,
                        aspectRatio: settings.format === '9:16' ? '9/16' : '16/9',
                        maxHeight: settings.format === '9:16' ? 220 : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {beat.status === 'ready' ? (
                        <img
                          src={beat.url}
                          alt={`Scene ${i + 1} · beat ${b + 1}`}
                          crossOrigin="anonymous"
                          className="wisi-lightbox-trigger"
                          onClick={() => setLightbox({ url: beat.url, alt: `Scene ${i + 1} · beat ${b + 1}` })}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase', textAlign: 'center', padding: 4, animation: beat.status === 'loading' ? 'wisiPulse 1.2s infinite' : 'none' }}>
                          {beat.status === 'loading' ? 'Drawing…' : beat.status === 'error' ? 'Failed — retry' : `Beat ${b + 1}`}
                        </span>
                      )}
                    </div>

                    <textarea
                      value={beat.prompt}
                      onChange={(e) => updateImage(scene.id, b, { prompt: e.target.value, status: 'idle' })}
                      rows={3}
                      style={{ ...inputStyle, marginTop: 6, fontSize: 14, lineHeight: 1.5, minHeight: 80, color: T.textSecondary, resize: 'vertical' }}
                      title={`Image prompt for beat ${b + 1} (English)`}
                    />

                    <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => genImage(scene.id, b, true)} disabled={running} style={{ ...btnGhost, padding: '5px 8px', fontSize: 9 }}>
                        ↻ Image
                      </button>
                      <select
                        value={beat.animation}
                        onChange={(e) => updateImage(scene.id, b, { animation: e.target.value })}
                        style={{ ...inputStyle, width: 'auto', padding: '4px 6px', fontSize: 9, marginLeft: 'auto' }}
                      >
                        {ANIMATION_LIST.map((a) => (
                          <option key={a} value={a}>
                            {a.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            <textarea
              value={scene.narration}
              onChange={(e) => updateScene(scene.id, { narration: e.target.value, audioStatus: 'idle', audioDuration: 0 })}
              rows={3}
              style={{ ...inputStyle, marginTop: 10, fontSize: 14, lineHeight: 1.5, minHeight: 80, resize: 'vertical' }}
            />

            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => genAudio(scene)} disabled={running} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                ↻ Voice
              </button>
              {scene.audioUrl && (
                <button onClick={() => new Audio(scene.audioUrl).play()} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                  ▶ Listen
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {lightbox && <ImageLightbox src={lightbox.url} alt={lightbox.alt} onClose={() => setLightbox(null)} />}

      {costConfirm && (
        <div
          onClick={() => setCostConfirm(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, maxWidth: 420, padding: 24 }}>
            <div style={{ fontFamily: FONT.display, fontSize: 20, color: T.text }}>Confirm paid generation</div>
            <div style={{ fontFamily: FONT.ui, fontSize: 14, color: T.textSecondary, marginTop: 12, lineHeight: 1.6 }}>
              This will generate ~{costConfirm.count} image{costConfirm.count === 1 ? '' : 's'} with{' '}
              {(PROVIDER_LABELS[costConfirm.provider] || costConfirm.provider).replace(/\s*\(.*\)$/, '')}, estimated cost ≈ $
              {costConfirm.total.toFixed(2)}. Continue?
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button onClick={confirmGenerateAll} style={{ ...btnPrimary, flex: 1 }}>
                Confirm & generate
              </button>
              <button onClick={() => setCostConfirm(null)} style={{ ...btnGhost, flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
