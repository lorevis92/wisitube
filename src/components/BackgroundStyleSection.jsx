import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { generateImage } from '../lib/sceneOrchestrator';
import { uploadMedia } from '../lib/mediaStorage';
import { recordCost } from '../lib/db';
import { priceForImage } from '../lib/imageProviders';

// "Background & text style" for content_type 'static_background' — shared between StoryboardStep.jsx
// (where a video's background is first set up, generation flowing through the shared cost-confirm
// dialog) and EditorStep.jsx (fine-tuning an already-generated video, no bulk cost-confirm flow at
// all). Fully self-contained (owns its own bgPrompt/bgBusy/bgError state) so a caller only ever has
// to pass it project/setProject/settings/channelId/videoId/userId — self-guards on content_type so
// callers don't need their own isStaticBackground check either.
//
// Exposes an imperative handle (ref) purely for StoryboardStep.jsx's "Confirm & generate" bulk
// flow — that cost dialog quotes this exact background image's cost alongside the voice cost (see
// StoryboardStep.jsx's estimateCost/pendingBackgroundImageCost), so confirming it needs to trigger
// the same generation this section's own button would, using whatever prompt is currently typed
// here, without duplicating this component's generation logic in the parent or lifting bgPrompt
// state up out of it. EditorStep.jsx has no such bulk flow and simply doesn't pass a ref.
const BackgroundStyleSection = forwardRef(function BackgroundStyleSection(
  { project, setProject, settings, channelId, videoId, userId },
  ref
) {
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState('');

  const dims = settings.format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
  // The image-provider-as-actually-used for a single still image — nanobanana-batch has no
  // single-image endpoint of its own (batch is only worth it at scale), so the background image
  // (like thumbnails, see thumbnailEngine.js) uses Nano Banana 2's ordinary synchronous provider
  // instead, same reasoning throughout this codebase.
  const effectiveBgProvider = settings.imageProvider === 'nanobanana-batch' ? 'nanobanana' : settings.imageProvider || 'pollinations';

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

  // Manual upload counterpart to generateBackgroundImage above — same immediate-upload-to-Storage
  // behavior as ChannelDashboardStep.jsx's own handleUploadStaticBgImage (a real videoId already
  // exists at this step, unlike CreateStep.jsx's version of this control, which has no video yet and
  // so has to defer the actual Storage upload until one is created).
  async function uploadBackgroundImage(file) {
    setBgBusy(true);
    setBgError('');
    try {
      const url = URL.createObjectURL(file);
      const imageStoragePath = await uploadMedia(userId, videoId, 'static-background', 'bg', file);
      setProject((p) => ({ ...p, staticBackground: { ...(p.staticBackground || {}), type: 'image', imageStoragePath, url, blob: file } }));
    } catch (err) {
      setBgError('Upload failed: ' + String(err.message || err));
    } finally {
      setBgBusy(false);
    }
  }

  function handleUploadBackgroundImage(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;
    uploadBackgroundImage(file);
  }

  // Standalone confirmation for the dedicated "Generate background" button — a plain window.confirm
  // (same pattern as other one-off paid actions in this codebase, e.g. ChannelDashboardStep.jsx's
  // channel/video deletions) rather than a shared cost-confirm dialog, since a caller's own bulk
  // "Confirm & generate" flow (if it has one — see the imperative handle above) only picks up an
  // already-pending background rather than triggering a fresh one from whatever prompt is typed here.
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

  useImperativeHandle(ref, () => ({
    hasPendingPrompt: () =>
      project.staticBackground?.type === 'image' && !project.staticBackground?.imageStoragePath && bgPrompt.trim().length > 0,
    generateFromCurrentPrompt: () => generateBackgroundImage(bgPrompt),
  }));

  if (settings.contentType !== 'static_background') return null;

  return (
    <div id="static-background-section" style={card}>
      <div style={label}>Background & text style</div>
      <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
        The whole video shows one unchanging background with the current scene's narration written on top.
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={() => setBackgroundType('color')} style={project.staticBackground?.type !== 'image' ? btnPrimary : btnGhost}>
          Solid color
        </button>
        <button onClick={() => setBackgroundType('image')} style={project.staticBackground?.type === 'image' ? btnPrimary : btnGhost}>
          Image
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
          <label style={{ ...btnGhost, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', opacity: bgBusy ? 0.6 : 1 }}>
            Upload image
            <input type="file" accept="image/*" onChange={handleUploadBackgroundImage} disabled={bgBusy} style={{ display: 'none' }} />
          </label>
          <div style={{ ...mono, fontSize: 10, color: T.textMuted, margin: '8px 0' }}>— or —</div>
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
            {bgBusy ? 'Working…' : project.staticBackground?.imageStoragePath ? '↻ Regenerate background' : 'Generate background'}
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
  );
});

export default BackgroundStyleSection;
