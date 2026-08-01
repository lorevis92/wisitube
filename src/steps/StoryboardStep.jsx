import React, { useEffect, useMemo, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { isModelWarm } from '../lib/tts';
import { estimateRemainingSeconds, formatDuration } from '../lib/estimator';
import { ANIMATION_LIST } from '../lib/engine';
import { priceForImage } from '../lib/imageProviders';
import { priceForVoice } from '../lib/voiceProviders';
import { generateBeatImage, generateSceneAudio, generateAllMedia } from '../lib/mediaGenerationEngine';
import { generateAllMediaViaBatch } from '../lib/geminiBatchImageEngine';
import { resumePendingBatches } from '../lib/batchResumption';
import { generateImage } from '../lib/sceneOrchestrator';
import { uploadMedia, downloadMediaAsBlob } from '../lib/mediaStorage';
import { recordCost } from '../lib/db';
import ImageLightbox from '../components/ImageLightbox';
import ExpandableTextarea from '../components/ExpandableTextarea';

// Array.isArray/length guard: projects saved before the 2-image-beat model lack `images`
// entirely — treat those as not-ready rather than crashing on scenes.every() over undefined.
// content_type 'static_background' scenes ALSO lack `images`, but intentionally (see
// App.jsx's buildScenesFromRaw) — isStaticBackground disambiguates the two cases.
const isSceneReady = (s, isStaticBackground = false) =>
  (isStaticBackground || (Array.isArray(s.images) && s.images.length > 0 && s.images.every((im) => im.status === 'ready'))) &&
  s.audioStatus === 'ready';

export default function StoryboardStep({ project, setProject, settings, onReady, channel, channelId, videoId, userId, isMobile }) {
  const [running, setRunning] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showSeo, setShowSeo] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [costConfirm, setCostConfirm] = useState(null); // { imageCount, imageTotal, charCount, voiceTotal, total } | null
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState('');

  const isStaticBackground = settings.contentType === 'static_background';
  const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };

  // Seeds this video's own background/text-style config from the channel's defaults exactly once
  // — only when this video has never had one set yet (project.staticBackground absent), so a later
  // per-video override (point 6) is never silently overwritten by re-seeding on every render/mount.
  // A channel default background IMAGE lives at its own Storage path (see ChannelDashboardStep.jsx)
  // — downloaded once here into a real blob/url so this video's own render/export can use it
  // exactly like any other image (see rehydrateProjectMedia's identical pattern for scene images).
  useEffect(() => {
    if (!isStaticBackground || project.staticBackground) return;
    let cancelled = false;
    (async () => {
      const hasChannelImage = !!channel?.automation_static_bg_image_path;
      let seeded = {
        type: hasChannelImage ? 'image' : 'color',
        color: channel?.automation_static_bg_color || '#111111',
        imageStoragePath: hasChannelImage ? channel.automation_static_bg_image_path : null,
        url: null,
        blob: null,
      };
      if (hasChannelImage) {
        try {
          const blob = await downloadMediaAsBlob(seeded.imageStoragePath);
          seeded = { ...seeded, blob, url: URL.createObjectURL(blob) };
        } catch (err) {
          console.error('[StoryboardStep] failed to load channel default background image', err);
          seeded = { type: 'color', color: seeded.color, imageStoragePath: null, url: null, blob: null };
        }
      }
      if (cancelled) return;
      setProject((p) =>
        p.staticBackground
          ? p
          : {
              ...p,
              staticBackground: seeded,
              staticTextStyle: p.staticTextStyle || {
                textColor: channel?.automation_static_text_color || '#FFFFFF',
                outline: channel?.automation_static_text_outline !== false,
                outlineColor: channel?.automation_static_text_outline_color || '#000000',
              },
            }
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaticBackground, channel?.id]);

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

  // Translates mediaGenerationEngine.js's onProgress events into this component's own state
  // updates — same shapes as the update functions above (updateImage(sceneId, beatIndex, patch),
  // updateScene(sceneId, patch)), so this is a direct passthrough, not a transform.
  // 'batch-submitted' (geminiBatchImageEngine.js) is the one event kind not native to this
  // component — appends the newly-submitted job to project.pendingImageBatches, same shape
  // fullPipelineRecipe.js's media phase already relies on for the automation path.
  function handleProgress(evt) {
    if (evt.kind === 'beat') updateImage(evt.sceneId, evt.beatIndex, evt.patch);
    else if (evt.kind === 'scene') updateScene(evt.sceneId, evt.patch);
    else if (evt.kind === 'message') setProgressMsg(evt.text);
    else if (evt.kind === 'batch-submitted') {
      setProject((p) => ({ ...p, pendingImageBatches: [...(p.pendingImageBatches || []), evt.pendingEntry] }));
    }
  }

  async function genImage(sceneId, beatIndex, newSeed = false) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return false;
    return generateBeatImage(scene, beatIndex, { settings, project, channelId, userId, videoId, newSeed, onProgress: handleProgress });
  }

  async function genAudio(scene) {
    return generateSceneAudio(scene, { settings, channelId, userId, videoId, onProgress: handleProgress });
  }

  async function generateAll() {
    setRunning(true);
    try {
      if (settings.imageProvider === 'nanobanana-batch') {
        // Audio still generates synchronously and immediately — voice has nothing to do with
        // which image provider is configured. skipImages so generateAllMedia's own image half
        // (irrelevant on this path) never runs.
        await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: handleProgress, skipImages: true });

        // Only submits when nothing is currently outstanding — the same guard
        // fullPipelineRecipe.js's media phase uses, so this button can't fire a second, duplicate
        // batch for scenes a still-pending job already claimed. Checking for a status update on an
        // outstanding batch is "🔄 Check for updates" below, not this button.
        if (!(project.pendingImageBatches || []).length) {
          await generateAllMediaViaBatch(project, { settings, channelId, videoId, logStep: null, resolution: '0.5K', onProgress: handleProgress });
        }
      } else if (isStaticBackground) {
        // No per-scene images to generate at all for this content type (see App.jsx's
        // buildScenesFromRaw) — only voice, plus the single background image if it's still
        // pending (type 'image', not yet generated, and a prompt has actually been entered) — the
        // cost dialog above (see estimateCost/pendingBackgroundImageCost) already quoted this
        // exact image alongside the voice cost, so generating it here too is what that
        // confirmation was actually about.
        await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: handleProgress, skipImages: true });
        if (project.staticBackground?.type === 'image' && !project.staticBackground?.imageStoragePath && bgPrompt.trim()) {
          await generateBackgroundImage(bgPrompt);
        }
      } else {
        await generateAllMedia(project, { settings, channelId, userId, videoId, onProgress: handleProgress });
      }
    } finally {
      setRunning(false);
    }
  }

  // On-demand resume for the manual flow — same resumePendingBatches the automation path uses, no
  // new logic. persist just calls setProject: App.jsx's own autosave effect (watching the lifted
  // `project` state) is what actually writes to Supabase, same as every other mutation in this file.
  async function checkForUpdates() {
    setCheckingUpdates(true);
    try {
      const updated = await resumePendingBatches(project, {
        userId,
        videoId,
        channelId,
        settings,
        onProgress: handleProgress,
        persist: async (proj) => setProject(proj),
      });
      setProject(updated);
    } catch (err) {
      console.error('[StoryboardStep] checkForUpdates failed', err);
    } finally {
      setCheckingUpdates(false);
    }
  }

  // A single still image, generated once for the whole video — not the per-beat pipeline at all,
  // just one plain call to the same generateImage/provider gateway every other image in this app
  // already goes through. Uploaded to Storage the same way scene images/thumbnails are, so it
  // survives a refresh via rehydrateProjectMedia (src/lib/mediaRehydration.js).
  async function generateBackgroundImage(prompt) {
    const trimmed = (prompt || '').trim();
    if (!trimmed) return;
    setBgBusy(true);
    setBgError('');
    try {
      const { imageUrl, costUsd } = await generateImage(trimmed, effectiveBgProvider, [], {
        width: dims.width,
        height: dims.height,
        seed: Math.floor(Math.random() * 999999),
        quality: 'medium',
      });
      if (costUsd > 0) await recordCost({ channelId, videoId, provider: effectiveBgProvider, type: 'image', amountUsd: costUsd });
      const blob = await (await fetch(imageUrl)).blob();
      const url = URL.createObjectURL(blob);
      const imageStoragePath = await uploadMedia(userId, videoId, 'static-background', 'bg', blob);
      setProject((p) => ({ ...p, staticBackground: { ...(p.staticBackground || {}), type: 'image', imageStoragePath, url, blob } }));
    } catch (err) {
      setBgError('Background generation failed: ' + String(err.message || err));
    } finally {
      setBgBusy(false);
    }
  }

  // Standalone confirmation for the dedicated "Generate background" button — a plain window.confirm
  // (same pattern as other one-off paid actions in this codebase, e.g. ChannelDashboardStep.jsx's
  // channel/video deletions) rather than the shared costConfirm dialog, since that dialog's own
  // "Confirm & generate" click doesn't run this — it runs generateAll, which only picks up an
  // already-pending background (see there) rather than triggering a fresh one from whatever prompt
  // is currently typed here.
  function requestGenerateBackgroundImage() {
    const trimmed = bgPrompt.trim();
    if (!trimmed) {
      setBgError('Enter a description for the background image.');
      return;
    }
    const cost = priceForImage(effectiveBgProvider, { width: dims.width, height: dims.height, quality: 'medium', hasReference: false });
    if (cost > 0 && !window.confirm(`Generate this background image using ${effectiveBgProvider} (~$${cost.toFixed(2)})?`)) return;
    generateBackgroundImage(bgPrompt);
  }

  function setBackgroundColor(color) {
    setProject((p) => ({
      ...p,
      staticBackground: { ...(p.staticBackground || {}), type: 'color', color },
    }));
  }

  function setBackgroundType(type) {
    setProject((p) => ({ ...p, staticBackground: { ...(p.staticBackground || {}), type } }));
  }

  function updateTextStyle(patch) {
    setProject((p) => ({ ...p, staticTextStyle: { ...(p.staticTextStyle || {}), ...patch } }));
  }

  // Paid providers require an explicit confirmation before any billable call goes out — computed
  // from the beats that actually still need generating (not a blind scenes×2 for the whole video),
  // so "Generate missing" on a partially-done video quotes only what will really be charged.
  function pendingBeats() {
    const list = [];
    project.scenes.forEach((s) => s.images.forEach((im) => { if (im.status !== 'ready') list.push(im); }));
    return list;
  }

  function pendingAudioCharCount() {
    return project.scenes
      .filter((s) => s.audioStatus !== 'ready')
      .reduce((sum, s) => sum + (s.narration?.length || 0), 0);
  }

  // The image-provider-as-actually-used for a single still image — nanobanana-batch has no
  // single-image endpoint of its own (batch is only worth it at scale), so the background image
  // (like thumbnails, see thumbnailEngine.js) uses Nano Banana 2's ordinary synchronous provider
  // instead, same reasoning throughout this codebase.
  const effectiveBgProvider = settings.imageProvider === 'nanobanana-batch' ? 'nanobanana' : settings.imageProvider || 'pollinations';

  // Real cost only when the background is actually still pending generation — a background
  // already generated (imageStoragePath set) was already billed at that point, and a 'color'
  // background is never billable at all.
  function pendingBackgroundImageCost() {
    if (!isStaticBackground || project.staticBackground?.type !== 'image' || project.staticBackground?.imageStoragePath) return 0;
    return priceForImage(effectiveBgProvider, { width: dims.width, height: dims.height, quality: 'medium', hasReference: false });
  }

  // Combines both billable axes — images and voice — into one estimate, since either (or both)
  // can be a paid engine independently of the other.
  //
  // 'static_background' has no per-scene image_beats at all (see api/generate-scenes.js) — quoting
  // a cost for scene beats that were never going to be generated would be a phantom line, so that
  // axis is excluded entirely. In its place: the single background image's real cost, but only
  // while it's still pending (see pendingBackgroundImageCost) — "Confirm & generate" (see
  // confirmGenerateAll) generates it together with the audio in that case, so this dialog quotes
  // exactly what that click is about to actually spend.
  function estimateCost() {
    const voiceEngine = settings.voiceEngine || 'kokoro';

    const beats = isStaticBackground ? [] : pendingBeats();
    const perSceneImageTotal = isStaticBackground
      ? 0
      : beats.reduce(
          (sum, beat) =>
            sum + priceForImage(settings.imageProvider || 'pollinations', { width: dims.width, height: dims.height, quality: 'medium', hasReference: !!beat.referenceId }),
          0
        );
    const bgImageTotal = pendingBackgroundImageCost();
    const imageTotal = perSceneImageTotal + bgImageTotal;
    const imageCount = beats.length + (bgImageTotal > 0 ? 1 : 0);

    const charCount = pendingAudioCharCount();
    const voiceTotal = priceForVoice(voiceEngine, charCount);

    return { imageCount, imageTotal, charCount, voiceTotal, total: imageTotal + voiceTotal };
  }

  function requestGenerateAll() {
    const estimate = estimateCost();
    if (estimate.total <= 0) {
      generateAll();
      return;
    }
    setCostConfirm(estimate);
  }

  function confirmGenerateAll() {
    setCostConfirm(null);
    generateAll();
  }

  const readyCount = project.scenes.filter((s) => isSceneReady(s, isStaticBackground)).length;
  const allReady = readyCount === project.scenes.length;
  const totalSec = project.scenes.reduce((a, s) => a + (s.audioDuration || 0) + s.pad, 0);
  const { syncSeconds: remainingSeconds, imageEta } = useMemo(
    () => estimateRemainingSeconds(project.scenes, isModelWarm(), settings.imageProvider),
    [project.scenes, settings.imageProvider]
  );

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
                <ExpandableTextarea
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

      {/* Gemini Batch jobs in flight for this video replace the normal generation control + grid
          entirely — same card design as AutomationMirrorStep.jsx's mirror of the same state, so a
          batch-provider video looks the same whether it's being watched from automation or here.
          Nothing here can accidentally re-submit a duplicate batch: the button that would is gone
          while this card is showing; "🔄 Check for updates" only ever checks/resumes. */}
      {(project.pendingImageBatches || []).length > 0 ? (() => {
        const allBatchBeats = project.scenes.flatMap((s) => s.images || []);
        const readyBatchBeats = allBatchBeats.filter((b) => b.status === 'ready');
        const batchPct = allBatchBeats.length ? Math.round((readyBatchBeats.length / allBatchBeats.length) * 100) : 0;
        return (
          <div style={card}>
            <div style={label}>Gemini Batch — images in progress</div>
            <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 10 }}>
              {readyBatchBeats.length} of {allBatchBeats.length} images ready — batch jobs in progress, may take up to a few hours
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${batchPct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
              </div>
              <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{batchPct}%</span>
            </div>
            <button
              onClick={checkForUpdates}
              disabled={checkingUpdates}
              style={{ ...btnPrimary, marginTop: 14, opacity: checkingUpdates ? 0.6 : 1 }}
            >
              {checkingUpdates ? 'Checking…' : '🔄 Check for updates'}
            </button>
            {readyBatchBeats.length > 0 && (
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
                  {readyBatchBeats.map((b) => (
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
      })() : (
        <>
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
            {allReady
              ? '⏱ Estimated time remaining: Done'
              : imageEta
                ? '⏱ Images will be generated via Gemini Batch — submitting shortly'
                : `⏱ Estimated time remaining: ${formatDuration(remainingSeconds)}`}
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
                {!isStaticBackground &&
                  scene.images.map((im, b) => (
                    <span key={im.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {statusDot(im.status)} img{b + 1}
                      {im.backupFailed && (
                        <span title="Upload to Supabase Storage failed — will be lost on refresh unless retried" style={{ color: T.primary }}>
                          ⚠ not backed up
                        </span>
                      )}
                    </span>
                  ))}
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {statusDot(scene.audioStatus, scene.audioStatus === 'error' ? scene.audioError : undefined)} voice
                  {scene.audioBackupFailed && (
                    <span title="Upload to Supabase Storage failed — will be lost on refresh unless retried" style={{ color: T.primary }}>
                      ⚠ not backed up
                    </span>
                  )}
                </span>
                {scene.audioDuration ? <span style={mono}>{scene.audioDuration.toFixed(1)}s</span> : null}
              </span>
            </div>

            {/* content_type 'static_background' scenes have no image_beats at all (see
                App.jsx's buildScenesFromRaw) — nothing per-scene to show or generate here, the
                one background for the whole video is configured once, below. */}
            {isStaticBackground ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  border: `1px dashed ${T.border}`,
                  borderRadius: 4,
                  fontSize: 12,
                  color: T.textSecondary,
                  fontFamily: FONT.ui,
                }}
              >
                This video uses a single background —{' '}
                <button
                  onClick={() => document.getElementById('static-background-section')?.scrollIntoView({ behavior: 'smooth' })}
                  style={{ background: 'none', border: 'none', padding: 0, color: T.primary, textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                >
                  configured below
                </button>
                .
              </div>
            ) : (
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

                    <ExpandableTextarea
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
            )}

            <ExpandableTextarea
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
        </>
      )}

      {isStaticBackground && (
        <div id="static-background-section" style={card}>
          <div style={label}>Background & text style</div>
          <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
            The whole video shows one unchanging background with the current scene's narration written on top.
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              onClick={() => setBackgroundType('color')}
              style={project.staticBackground?.type !== 'image' ? btnPrimary : btnGhost}
            >
              Solid color
            </button>
            <button
              onClick={() => setBackgroundType('image')}
              style={project.staticBackground?.type === 'image' ? btnPrimary : btnGhost}
            >
              Generated image
            </button>
          </div>

          {project.staticBackground?.type === 'image' ? (
            <div style={{ marginTop: 12 }}>
              {project.staticBackground?.url && (
                <img
                  src={project.staticBackground.url}
                  alt="Background"
                  style={{ width: '100%', maxWidth: 320, borderRadius: 4, border: `1px solid ${T.border}`, marginBottom: 8, display: 'block' }}
                />
              )}
              <input
                value={bgPrompt}
                onChange={(e) => setBgPrompt(e.target.value)}
                placeholder="Describe the background image…"
                style={inputStyle}
              />
              <button
                onClick={requestGenerateBackgroundImage}
                disabled={bgBusy}
                style={{ ...btnPrimary, marginTop: 8, opacity: bgBusy ? 0.6 : 1 }}
              >
                {bgBusy ? 'Generating…' : project.staticBackground?.imageStoragePath ? '↻ Regenerate background' : 'Generate background'}
              </button>
              {bgError && <div style={{ marginTop: 8, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{bgError}</div>}
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <input
                type="color"
                value={project.staticBackground?.color || '#111111'}
                onChange={(e) => setBackgroundColor(e.target.value)}
                style={{ width: 60, height: 36, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
              />
            </div>
          )}

          <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <div style={label}>Text style</div>
            <div style={{ display: 'flex', gap: 18, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                Text color
                <input
                  type="color"
                  value={project.staticTextStyle?.textColor || '#FFFFFF'}
                  onChange={(e) => updateTextStyle({ textColor: e.target.value })}
                  style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                <input
                  type="checkbox"
                  checked={project.staticTextStyle?.outline !== false}
                  onChange={(e) => updateTextStyle({ outline: e.target.checked })}
                />
                Outline
              </label>
              {project.staticTextStyle?.outline !== false && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                  Outline color
                  <input
                    type="color"
                    value={project.staticTextStyle?.outlineColor || '#000000'}
                    onChange={(e) => updateTextStyle({ outlineColor: e.target.value })}
                    style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>
      )}

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
            <div style={{ fontFamily: FONT.ui, fontSize: 14, color: T.textSecondary, marginTop: 12, lineHeight: 1.8 }}>
              {costConfirm.imageTotal > 0 && (
                <div>
                  Images: ~{costConfirm.imageCount} × ${(costConfirm.imageTotal / costConfirm.imageCount).toFixed(2)} ≈ $
                  {costConfirm.imageTotal.toFixed(2)}
                </div>
              )}
              {costConfirm.voiceTotal > 0 && (
                <div>
                  Voice: ~{costConfirm.charCount.toLocaleString()} characters × $0.10/1K ≈ ${costConfirm.voiceTotal.toFixed(2)}
                </div>
              )}
              <div style={{ fontWeight: 700, color: T.text, marginTop: 6 }}>Total ≈ ${costConfirm.total.toFixed(2)}</div>
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
