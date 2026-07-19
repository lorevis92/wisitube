import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { STYLES, loadImage, decodeAudio } from '../lib/pollinations';
import { playTimeline } from '../lib/engine';
import { renderToMp4, WebCodecsUnsupportedError } from '../lib/exporter';
import { recordCost } from '../lib/db';
import { uploadVideoToYoutube } from '../lib/youtubeUpload';
import { buildSrtFromScenes } from '../lib/srtBuilder';
import { generateImage } from '../lib/sceneOrchestrator';
import { buildTelegraphicPrompt, buildNaturalLanguagePrompt } from '../lib/promptBuilders';

// Official YouTube video category IDs (googleapis.com/youtube/v3/videoCategories) — the ones
// realistically relevant to faceless explainer-style channels, skipping deprecated categories
// (Movies, Shows, Videoblogging, Short Movies) that YouTube no longer accepts on new uploads.
const YOUTUBE_CATEGORIES = [
  { id: '27', label: 'Education' },
  { id: '28', label: 'Science & Technology' },
  { id: '24', label: 'Entertainment' },
  { id: '22', label: 'People & Blogs' },
  { id: '23', label: 'Comedy' },
  { id: '25', label: 'News & Politics' },
  { id: '26', label: 'Howto & Style' },
  { id: '1', label: 'Film & Animation' },
  { id: '10', label: 'Music' },
  { id: '20', label: 'Gaming' },
  { id: '17', label: 'Sports' },
  { id: '19', label: 'Travel & Events' },
  { id: '2', label: 'Autos & Vehicles' },
  { id: '15', label: 'Pets & Animals' },
  { id: '29', label: 'Nonprofits & Activism' },
];

const YOUTUBE_LANGUAGE_CODES = { English: 'en', Italiano: 'it', Español: 'es', Français: 'fr', Deutsch: 'de' };

// Local datetime-local string (no timezone conversion surprises) a few minutes in the future, so
// the scheduler's default/min never lands in the past the instant the panel renders.
function minScheduleLocal() {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ExportStep({ project, setProject, settings, channel, channelId, videoId, isMobile }) {
  const canvasRef = useRef(null);
  const controllerRef = useRef(null);
  const abortRef = useRef(null);
  const [rendering, setRendering] = useState(false);
  const [pct, setPct] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  // The raw Blob behind videoUrl — kept separately so the YouTube upload can hand it straight to
  // uploadVideoToYoutube instead of re-fetching the blob: URL, which is known to go invalid across
  // navigations/idle time even while videoUrl itself still looks like a valid string.
  const [renderedBlob, setRenderedBlob] = useState(null);
  const [fileExt, setFileExt] = useState('mp4');
  const [usingFallback, setUsingFallback] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  // Thumbnail state
  const thumbCanvasRef = useRef(null);
  const [thumbIdx, setThumbIdx] = useState(0);
  const [thumbText, setThumbText] = useState(project.thumbnails[0]?.overlay_text || '');
  const [thumbSeed, setThumbSeed] = useState(7);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbReady, setThumbReady] = useState(false);

  const dims = settings.format === '9:16' ? { W: 720, H: 1280 } : { W: 1280, H: 720 };
  const scenes = project.scenes;
  const total = scenes.reduce((a, s) => a + (s.audioDuration || 0) + s.pad, 0);
  const title = project.titles[project.selectedTitle] || project.titles[0] || 'wisitube-video';

  // YouTube publishing state — `channel` is a prop, not local state: App.jsx is the single source
  // of truth (loaded/updated by ChannelDashboardStep, which always mounts before this step is
  // reachable), so there's no independent fetch here that could drift out of sync with it.
  const [ytTitle, setYtTitle] = useState(title);
  const [ytDescription, setYtDescription] = useState(project.description || '');
  const [ytTags, setYtTags] = useState((project.tags || []).join(', '));
  const [ytCategory, setYtCategory] = useState('27');
  const [ytPrivacy, setYtPrivacy] = useState('public');
  const [ytScheduleMode, setYtScheduleMode] = useState('now'); // 'now' | 'schedule'
  const [ytPublishAt, setYtPublishAt] = useState(minScheduleLocal());
  const [ytMadeForKids, setYtMadeForKids] = useState(false);
  const [ytUploadCaptions, setYtUploadCaptions] = useState(true);
  const [ytAddToPlaylist, setYtAddToPlaylist] = useState(!!project.series);

  const [ytBusy, setYtBusy] = useState(false);
  const [ytUploadPct, setYtUploadPct] = useState(0);
  const [ytVideoId, setYtVideoId] = useState('');
  const [ytErrors, setYtErrors] = useState({}); // { upload, thumbnail, captions, playlist }
  const [ytFormError, setYtFormError] = useState('');

  const isYoutubeConnected = !!channel?.youtube_connected;

  // Resuming a video that was already rendered in a previous session: project.renderedVideoBlob
  // came back from IndexedDB (see App.jsx handleResume), so rebuild the preview/upload state from
  // it instead of forcing the user to render again just to get a fresh (but functionally
  // identical) blob: URL.
  useEffect(() => {
    if (!videoUrl && project.renderedVideoBlob) {
      setRenderedBlob(project.renderedVideoBlob);
      setVideoUrl(URL.createObjectURL(project.renderedVideoBlob));
      setFileExt(project.renderedVideoBlob.type === 'video/webm' ? 'webm' : 'mp4');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function renderVideo() {
    setError('');
    setVideoUrl('');
    setRenderedBlob(null);
    setUsingFallback(false);
    setRendering(true);
    setPct(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const items = await Promise.all(
        scenes.map(async (s) => ({
          images: await Promise.all(
            s.images.map(async (beat) => ({ img: await loadImage(beat.url), animation: beat.animation }))
          ),
          buffer: await decodeAudio(s.audioUrl),
          duration: (s.audioDuration || 0) + s.pad,
          narration: s.narration,
        }))
      );

      let blob, ext;
      try {
        blob = await renderToMp4({
          items,
          width: dims.W,
          height: dims.H,
          subtitles: project.subtitles,
          onProgress: (frameIndex, totalFrames) => setPct(Math.min(100, Math.round((frameIndex / totalFrames) * 100))),
          signal: controller.signal,
        });
        ext = 'mp4';
      } catch (e) {
        if (!(e instanceof WebCodecsUnsupportedError)) throw e;
        // Fast path unavailable in this browser — fall back to the original real-time recorder.
        setUsingFallback(true);
        setPct(0);
        const playback = await playTimeline({
          canvas: canvasRef.current,
          items,
          subtitles: project.subtitles,
          record: true,
          onProgress: (t, tot) => setPct(Math.min(100, Math.round((t / tot) * 100))),
          onDone: () => {},
        });
        controllerRef.current = playback;
        blob = await playback.blobPromise;
        ext = 'webm';
      }
      setVideoUrl(URL.createObjectURL(blob));
      setFileExt(ext);
      setRenderedBlob(blob);
      // Same pattern as scene images/audio (StoryboardStep.jsx) — the Blob rides on the project
      // record itself, so App.jsx's existing debounced autosave persists it to IndexedDB. That's
      // what lets a resumed session (see the mount effect above) skip re-rendering entirely.
      setProject((p) => ({ ...p, renderedVideoBlob: blob }));
    } catch (e) {
      if (e?.name !== 'AbortError') setError('Render failed: ' + String(e.message || e));
    } finally {
      setRendering(false);
    }
  }

  function cancelRender() {
    abortRef.current?.abort();
    controllerRef.current?.stop();
    setRendering(false);
  }

  function copy(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    });
  }

  // Same telegraphic-vs-natural-language branching StoryboardStep.jsx's fullPrompt() already uses
  // for scene beats — Pollinations wants compact fragments, Nano Banana 2 / GPT Image 2 want full
  // sentences. No character/reference anchoring here since thumbnails have no such selector.
  function thumbnailPrompt(concept) {
    const flavoredPrompt = `${concept.image_prompt}, YouTube thumbnail style, bold colors, high contrast, dramatic, eye catching`;
    const style = STYLES[settings.style];
    const provider = settings.imageProvider || 'pollinations';
    if (provider === 'pollinations') {
      return buildTelegraphicPrompt({ scenePrompt: flavoredPrompt, styleSuffix: style.suffix });
    }
    // Premium providers bake the overlay text directly into the generated image instead of the
    // canvas overlay pollinations gets below — an explicit typography instruction steers them
    // toward something that reads like a real YouTube thumbnail rather than a generic caption.
    const textInstruction = `Include the exact text '${thumbText}' rendered directly in the image as bold, high-contrast YouTube thumbnail typography — thick sans-serif font, white or yellow fill with a black outline/drop shadow for readability, positioned in the lower third of the frame, sized large and impactful like professional YouTube thumbnails. The text must be spelled exactly as given, no alterations.`;
    return buildNaturalLanguagePrompt({ scenePrompt: `${flavoredPrompt}. ${textInstruction}`, styleDescription: style.natural });
  }

  async function makeThumbnail() {
    setThumbBusy(true);
    setThumbReady(false);
    try {
      const concept = project.thumbnails[thumbIdx];
      const provider = settings.imageProvider || 'pollinations';
      // Same unified gateway (and the same server-side FAL_KEY auth) StoryboardStep.jsx already
      // uses for every scene beat — routes nanobanana/gptimage through fal.ai instead of always
      // hitting Pollinations regardless of the provider chosen for the rest of the video.
      const { imageUrl, costUsd } = await generateImage(thumbnailPrompt(concept), provider, [], {
        width: 1280,
        height: 720,
        seed: thumbSeed,
        quality: 'medium',
      });
      // Real spend only — Pollinations always returns costUsd: 0, so nothing gets logged for it.
      if (costUsd > 0) await recordCost({ channelId, videoId, provider, type: 'image', amountUsd: costUsd });
      const img = await loadImage(imageUrl);
      const c = thumbCanvasRef.current;
      const ctx = c.getContext('2d');
      // cover-fit
      const ir = img.width / img.height;
      const cr = 1280 / 720;
      let dw, dh;
      if (ir > cr) { dh = 720; dw = 720 * ir; } else { dw = 1280; dh = 1280 / ir; }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1280, 720);
      ctx.drawImage(img, (1280 - dw) / 2, (720 - dh) / 2, dw, dh);

      if (provider === 'pollinations') {
        await document.fonts.ready;
        // bottom gradient for legibility
        const g = ctx.createLinearGradient(0, 380, 0, 720);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.75)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 380, 1280, 340);
        // overlay text
        const text = (thumbText || '').toUpperCase();
        const words = text.split(/\s+/).filter(Boolean);
        const lines = words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [text];
        let size = 110;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const fit = (s) => {
          ctx.font = `800 ${s}px Syne, sans-serif`;
          return lines.every((ln) => ctx.measureText(ln).width < 1180);
        };
        while (size > 48 && !fit(size)) size -= 6;
        ctx.font = `800 ${size}px Syne, sans-serif`;
        const lineH = size * 1.08;
        lines.forEach((ln, i) => {
          const y = 720 - 56 - (lines.length - 1 - i) * lineH;
          ctx.lineWidth = size * 0.14;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = '#000000';
          ctx.strokeText(ln, 640, y);
          ctx.fillStyle = i === lines.length - 1 ? '#FFD400' : '#FFFFFF';
          ctx.fillText(ln, 640, y);
        });
      }
      // Premium providers (nanobanana/gptimage) already baked the text into the generated image
      // itself (see thumbnailPrompt) — the cover-fit above is the only processing it needs.

      setThumbReady(true);
    } catch (e) {
      setError('Thumbnail failed: ' + String(e.message || e));
    } finally {
      setThumbBusy(false);
    }
  }

  function downloadThumb() {
    const a = document.createElement('a');
    a.download = 'wisitube-thumbnail.png';
    a.href = thumbCanvasRef.current.toDataURL('image/png');
    a.click();
  }

  // ---- YouTube publishing ----
  // Each run* function owns and clears only its own ytErrors key and never throws — a failure in
  // one phase (e.g. the thumbnail) must never wipe out a result already achieved by an earlier one
  // (e.g. a successfully uploaded video), and each phase needs to be independently retryable.

  async function runUpload() {
    console.log('[yt-upload] phase=runUpload:enter');
    setYtErrors((e) => ({ ...e, upload: null }));
    setYtUploadPct(0);
    try {
      const refreshToken = channel?.youtube_refresh_token;
      if (!refreshToken) throw new Error('This channel is not connected to YouTube.');
      if (!videoUrl) throw new Error('Render the video first.');

      const publishAt = ytScheduleMode === 'schedule' && ytPublishAt ? new Date(ytPublishAt).toISOString() : null;

      console.log('[yt-upload] phase=init-upload:before', { channelId, videoUrl, publishAt });
      let initRes;
      try {
        initRes = await fetch('/api/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'init-upload',
            channelId,
            refreshToken,
            title: ytTitle,
            description: ytDescription,
            tags: ytTags.split(',').map((t) => t.trim()).filter(Boolean),
            categoryId: ytCategory,
            language: YOUTUBE_LANGUAGE_CODES[settings.language] || 'en',
            privacyStatus: ytPrivacy,
            publishAt,
            madeForKids: ytMadeForKids,
          }),
        });
      } catch (err) {
        console.error('[yt-upload] phase=init-upload:fetch-error', err?.message, err?.stack);
        throw err;
      }
      console.log('[yt-upload] phase=init-upload:after', { status: initRes.status, ok: initRes.ok });

      let initData;
      try {
        initData = await initRes.json();
      } catch (err) {
        console.error('[yt-upload] phase=init-upload:parse-json-error', err?.message, err?.stack);
        throw err;
      }
      // The exact uploadUrl string is the thing to check first when the PUT below fails before
      // ever reaching googleapis.com — undefined/malformed here means init-upload didn't return
      // what this code assumes it did.
      console.log('[yt-upload] phase=init-upload:data', {
        uploadUrl: initData.uploadUrl,
        uploadUrlType: typeof initData.uploadUrl,
        hasAccessToken: !!initData.accessToken,
      });
      if (!initRes.ok) throw new Error(initData.error || 'Could not start the YouTube upload');

      // Never re-fetch videoUrl (a blob: URL) here — it's known to go invalid across
      // navigations/idle time even while the string itself still looks fine, which is what caused
      // "Failed to fetch" with no request ever reaching googleapis.com. Use the Blob already in
      // memory from this session's render, or the one restored from IndexedDB on resume (see the
      // mount effect above) — never a re-fetch of the transient URL.
      const videoBlob = renderedBlob || project.renderedVideoBlob;
      if (!videoBlob) throw new Error('Render the video first.');
      console.log('[yt-upload] phase=video-blob:resolved', {
        source: renderedBlob ? 'in-memory (this session)' : 'project.renderedVideoBlob (resumed from IndexedDB)',
        size: videoBlob.size,
        type: videoBlob.type,
      });

      console.log('[yt-upload] phase=upload-video-to-youtube:before', {
        uploadUrl: initData.uploadUrl,
        blobSize: videoBlob.size,
        hasAccessToken: !!initData.accessToken,
        hasProgressCallback: true,
      });
      let videoId;
      try {
        videoId = await uploadVideoToYoutube(initData.uploadUrl, videoBlob, initData.accessToken, (p) => setYtUploadPct(p));
      } catch (err) {
        console.error('[yt-upload] phase=upload-video-to-youtube:error', err?.message, err?.stack);
        throw err;
      }
      console.log('[yt-upload] phase=upload-video-to-youtube:after', { videoId });

      setYtVideoId(videoId);
      return videoId;
    } catch (e) {
      console.error('[yt-upload] phase=runUpload:catch', e?.message, e?.stack);
      setYtErrors((prev) => ({ ...prev, upload: String(e.message || e) }));
      return null;
    }
  }

  async function runThumbnail(videoId) {
    console.log('[yt-upload] phase=runThumbnail:enter', { videoId, thumbReady });
    if (!thumbReady) return true; // no custom thumbnail made — YouTube's auto-picked one applies
    setYtErrors((e) => ({ ...e, thumbnail: null }));
    try {
      const refreshToken = channel?.youtube_refresh_token;
      const dataUrl = thumbCanvasRef.current.toDataURL('image/png');
      console.log('[yt-upload] phase=set-thumbnail:before', { videoId, dataUrlLength: dataUrl?.length });
      let res;
      try {
        res = await fetch('/api/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-thumbnail', channelId, refreshToken, videoId, thumbnailBlob: dataUrl }),
        });
      } catch (err) {
        console.error('[yt-upload] phase=set-thumbnail:fetch-error', err?.message, err?.stack);
        throw err;
      }
      console.log('[yt-upload] phase=set-thumbnail:after', { status: res.status, ok: res.ok });
      const data = await res.json();
      if (!res.ok) {
        // error is a string for our own validation failures, but a boolean flag when it's a
        // passthrough of Google's response (see api/youtube.js set-thumbnail) — the real message
        // is in detail/status in that case.
        const message =
          typeof data.error === 'string' && data.error
            ? data.error
            : `YouTube rejected the thumbnail (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
        throw new Error(message);
      }
      return true;
    } catch (e) {
      console.error('[yt-upload] phase=runThumbnail:catch', e?.message, e?.stack);
      setYtErrors((prev) => ({ ...prev, thumbnail: String(e.message || e) }));
      return false;
    }
  }

  async function runCaptions(videoId) {
    console.log('[yt-upload] phase=runCaptions:enter', { videoId, ytUploadCaptions });
    if (!ytUploadCaptions) return true;
    setYtErrors((e) => ({ ...e, captions: null }));
    try {
      const refreshToken = channel?.youtube_refresh_token;
      const srtContent = buildSrtFromScenes(project.scenes);
      console.log('[yt-upload] phase=set-captions:before', { videoId, srtLength: srtContent?.length });
      let res;
      try {
        res = await fetch('/api/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-captions', channelId, refreshToken, videoId, srtContent, language: YOUTUBE_LANGUAGE_CODES[settings.language] || 'en' }),
        });
      } catch (err) {
        console.error('[yt-upload] phase=set-captions:fetch-error', err?.message, err?.stack);
        throw err;
      }
      console.log('[yt-upload] phase=set-captions:after', { status: res.status, ok: res.ok });
      const data = await res.json();
      if (!res.ok) {
        // error is a string for our own validation failures, but a boolean flag when it's a
        // passthrough of Google's response (see api/youtube.js set-captions) — the real message
        // is in detail/status in that case.
        const message =
          typeof data.error === 'string' && data.error
            ? data.error
            : `YouTube rejected the captions (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
        throw new Error(message);
      }
      return true;
    } catch (e) {
      console.error('[yt-upload] phase=runCaptions:catch', e?.message, e?.stack);
      setYtErrors((prev) => ({ ...prev, captions: String(e.message || e) }));
      return false;
    }
  }

  async function runPlaylist(videoId) {
    console.log('[yt-upload] phase=runPlaylist:enter', { videoId, ytAddToPlaylist, series: project.series });
    if (!ytAddToPlaylist || !project.series) return true;
    setYtErrors((e) => ({ ...e, playlist: null }));
    try {
      const refreshToken = channel?.youtube_refresh_token;
      console.log('[yt-upload] phase=add-to-playlist:before', { videoId, seriesName: project.series });
      let res;
      try {
        res = await fetch('/api/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add-to-playlist', channelId, refreshToken, videoId, seriesName: project.series }),
        });
      } catch (err) {
        console.error('[yt-upload] phase=add-to-playlist:fetch-error', err?.message, err?.stack);
        throw err;
      }
      console.log('[yt-upload] phase=add-to-playlist:after', { status: res.status, ok: res.ok });
      const data = await res.json();
      if (!res.ok) {
        // error is a string for our own validation failures, but a boolean flag when it's a
        // passthrough of Google's response (see api/youtube.js add-to-playlist) — the real message
        // is in detail/status in that case.
        const message =
          typeof data.error === 'string' && data.error
            ? data.error
            : `Could not add the video to its series playlist (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
        throw new Error(message);
      }
      return true;
    } catch (e) {
      console.error('[yt-upload] phase=runPlaylist:catch', e?.message, e?.stack);
      setYtErrors((prev) => ({ ...prev, playlist: String(e.message || e) }));
      return false;
    }
  }

  async function publishToYoutube() {
    setYtFormError('');
    if (!videoUrl) {
      setYtFormError('Render the video before publishing to YouTube.');
      return;
    }
    if (ytScheduleMode === 'schedule' && new Date(ytPublishAt).getTime() <= Date.now()) {
      setYtFormError('Scheduled publish time must be in the future.');
      return;
    }
    setYtBusy(true);
    console.log('[yt-upload] phase=publishToYoutube:enter', { existingVideoId: ytVideoId });
    try {
      let videoId = ytVideoId;
      if (!videoId) videoId = await runUpload();
      console.log('[yt-upload] phase=publishToYoutube:after-upload', { videoId });
      if (videoId) {
        await runThumbnail(videoId);
        await runCaptions(videoId);
        await runPlaylist(videoId);
      }
      console.log('[yt-upload] phase=publishToYoutube:exit');
    } finally {
      setYtBusy(false);
    }
  }

  async function retryPhase(phase) {
    setYtBusy(true);
    try {
      if (phase === 'upload') {
        const videoId = await runUpload();
        if (videoId) {
          await runThumbnail(videoId);
          await runCaptions(videoId);
          await runPlaylist(videoId);
        }
      } else if (phase === 'thumbnail') {
        await runThumbnail(ytVideoId);
      } else if (phase === 'captions') {
        await runCaptions(ytVideoId);
      } else if (phase === 'playlist') {
        await runPlaylist(ytVideoId);
      }
    } finally {
      setYtBusy(false);
    }
  }

  const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Video export */}
      <div style={card}>
        <div style={label}>5 · Export video</div>
        <div style={{ fontSize: 13, color: T.textSecondary, marginTop: 8, fontFamily: FONT.ui }}>
          Rendering runs offline in your browser — usually 3-6x faster than the video's own length
          (~{Math.max(1, Math.round(total / 6))}-{Math.max(1, Math.round(total / 3))}s for this video). Keep this tab open until it finishes.
          Output is <span style={mono}>.mp4</span> — YouTube accepts it directly.
        </div>
        {usingFallback && (
          <div style={{ marginTop: 10, fontSize: 12, color: T.yellow, fontFamily: FONT.ui }}>
            Your browser doesn't support fast export — falling back to real-time WebM.
          </div>
        )}
        {/* Only actually rendered to when the WebM fallback path runs (needs a live canvas to
            captureStream from) — the fast path draws to its own offscreen canvas instead. */}
        <canvas ref={canvasRef} width={dims.W} height={dims.H} style={{ display: 'none' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {rendering ? (
            <>
              <button onClick={cancelRender} style={btnGhost}>■ Cancel</button>
              <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden', minWidth: 120 }}>
                <div style={{ width: `${pct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
              </div>
              <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{pct}%</span>
            </>
          ) : (
            <button onClick={renderVideo} style={{ ...btnPrimary, padding: '12px 20px' }}>
              {videoUrl ? '↻ Render again' : '● Render video'}
            </button>
          )}
          {videoUrl && !rendering && (
            <a
              href={videoUrl}
              download={`${safeName}.${fileExt}`}
              style={{ ...btnPrimary, background: T.green, borderColor: T.green, textDecoration: 'none', padding: '12px 20px' }}
            >
              ↓ Download .{fileExt}
            </a>
          )}
        </div>
        {videoUrl && !rendering && (
          <video src={videoUrl} controls style={{ width: '100%', marginTop: 12, borderRadius: 4, border: `1px solid ${T.border}` }} />
        )}
        {error && <div style={{ marginTop: 10, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{error}</div>}
      </div>

      {/* Thumbnail */}
      <div style={card}>
        <div style={label}>6 · Thumbnail</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {project.thumbnails.map((tc, i) => {
            const active = i === thumbIdx;
            return (
              <button
                key={i}
                onClick={() => {
                  setThumbIdx(i);
                  setThumbText(tc.overlay_text);
                  setThumbReady(false);
                }}
                style={{
                  textAlign: 'left',
                  padding: '10px 14px',
                  borderRadius: 4,
                  border: `1px solid ${active ? T.primary : T.border}`,
                  background: active ? T.primaryLight : '#FFFFFF',
                  fontSize: 13,
                  fontFamily: FONT.ui,
                  color: T.text,
                }}
              >
                <strong>{tc.overlay_text}</strong>
                <span style={{ color: T.textSecondary }}> — {tc.image_prompt}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={thumbText} onChange={(e) => setThumbText(e.target.value)} placeholder="Overlay text" style={{ ...inputStyle, flex: 1, minWidth: 180 }} />
          <button
            onClick={() => {
              setThumbSeed(Math.floor(Math.random() * 999999));
              makeThumbnail();
            }}
            disabled={thumbBusy}
            style={btnGhost}
          >
            ↻ New image
          </button>
          <button onClick={makeThumbnail} disabled={thumbBusy} style={btnPrimary}>
            {thumbBusy ? 'Creating…' : 'Create thumbnail'}
          </button>
        </div>
        {(settings.imageProvider === 'nanobanana' || settings.imageProvider === 'gptimage') && (
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 6 }}>
            AI-generated text may need a retry to get spelling/layout right.
          </div>
        )}
        <canvas
          ref={thumbCanvasRef}
          width={1280}
          height={720}
          style={{ width: '100%', marginTop: 12, borderRadius: 4, border: `1px solid ${T.border}`, display: thumbReady || thumbBusy ? 'block' : 'none', background: T.surfaceAlt }}
        />
        {thumbReady && (
          <button onClick={downloadThumb} style={{ ...btnPrimary, background: T.green, borderColor: T.green, marginTop: 10 }}>
            ↓ Download PNG
          </button>
        )}
      </div>

      {/* SEO pack */}
      <div style={card}>
        <div style={label}>7 · Copy your upload pack</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          {[
            { key: 'title', name: 'Title', value: title },
            { key: 'desc', name: 'Description', value: project.description },
            { key: 'tags', name: 'Tags', value: project.tags.join(', ') },
          ].map((item) => (
            <div key={item.key} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={label}>{item.name}</span>
                <button onClick={() => copy(item.value, item.key)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 10 }}>
                  {copied === item.key ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 6, whiteSpace: 'pre-wrap', fontFamily: FONT.ui }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Publish to YouTube — only for a channel that's actually gone through the OAuth connect
          flow (ChannelDashboardStep); everyone else just downloads/copies the pack above. */}
      {isYoutubeConnected && (
        <div style={card}>
          <div style={label}>8 · Publish to YouTube</div>
          <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 6, fontFamily: FONT.ui }}>
            Publishing to <strong>{channel.youtube_channel_name || 'your connected channel'}</strong>. Render the video above first.
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={label}>Title</div>
            <input value={ytTitle} onChange={(e) => setYtTitle(e.target.value)} style={{ ...inputStyle, marginTop: 8 }} />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={label}>Description</div>
            <textarea
              value={ytDescription}
              onChange={(e) => setYtDescription(e.target.value)}
              rows={4}
              style={{ ...inputStyle, marginTop: 8, resize: 'vertical' }}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={label}>Tags (comma-separated)</div>
            <input value={ytTags} onChange={(e) => setYtTags(e.target.value)} style={{ ...inputStyle, marginTop: 8 }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, marginTop: 14 }}>
            <div>
              <div style={label}>Category</div>
              <select value={ytCategory} onChange={(e) => setYtCategory(e.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
                {YOUTUBE_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={label}>Privacy</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {['public', 'unlisted', 'private'].map((p) => (
                  <button
                    key={p}
                    onClick={() => setYtPrivacy(p)}
                    style={{ ...(ytPrivacy === p ? btnPrimary : btnGhost), flex: 1, textTransform: 'capitalize' }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={label}>Publish date</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => setYtScheduleMode('now')}
                  style={{ ...(ytScheduleMode === 'now' ? btnPrimary : btnGhost), flex: 1 }}
                >
                  Publish now
                </button>
                <button
                  onClick={() => setYtScheduleMode('schedule')}
                  style={{ ...(ytScheduleMode === 'schedule' ? btnPrimary : btnGhost), flex: 1 }}
                >
                  Schedule
                </button>
              </div>
              {ytScheduleMode === 'schedule' && (
                <input
                  type="datetime-local"
                  value={ytPublishAt}
                  min={minScheduleLocal()}
                  onChange={(e) => setYtPublishAt(e.target.value)}
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
            </div>
            <div>
              <div style={label}>Made for kids</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {[{ v: false, l: 'No' }, { v: true, l: 'Yes' }].map((opt) => (
                  <button
                    key={opt.l}
                    onClick={() => setYtMadeForKids(opt.v)}
                    style={{ ...(ytMadeForKids === opt.v ? btnPrimary : btnGhost), flex: 1 }}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontFamily: FONT.ui, color: T.text }}>
              <input type="checkbox" checked={ytUploadCaptions} onChange={(e) => setYtUploadCaptions(e.target.checked)} />
              Upload captions (.srt, generated from the narration timing)
            </label>
            {project.series && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontFamily: FONT.ui, color: T.text }}>
                <input type="checkbox" checked={ytAddToPlaylist} onChange={(e) => setYtAddToPlaylist(e.target.checked)} />
                Add to series playlist — "{project.series}"
              </label>
            )}
          </div>

          {ytFormError && <div style={{ marginTop: 12, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{ytFormError}</div>}

          <div style={{ marginTop: 18 }}>
            <button
              onClick={publishToYoutube}
              disabled={ytBusy || !videoUrl}
              style={{ ...btnPrimary, padding: '12px 20px', opacity: ytBusy || !videoUrl ? 0.6 : 1 }}
            >
              {ytBusy ? 'Publishing…' : ytVideoId ? '↻ Retry remaining steps' : '▲ Upload to YouTube'}
            </button>
            {!videoUrl && (
              <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 6 }}>Render the video first.</div>
            )}
          </div>

          {(ytBusy || ytVideoId) && !ytErrors.upload && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginBottom: 6 }}>
                {ytVideoId ? '✓ Video uploaded' : `Uploading… ${ytUploadPct}%`}
              </div>
              {!ytVideoId && (
                <div style={{ height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${ytUploadPct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
                </div>
              )}
            </div>
          )}

          {/* Per-phase failures — the upload can succeed while a later phase fails, so each one
              gets its own message and its own retry button rather than one blanket error. */}
          {[
            { key: 'upload', label: 'Upload' },
            { key: 'thumbnail', label: 'Thumbnail' },
            { key: 'captions', label: 'Captions' },
            { key: 'playlist', label: 'Series playlist' },
          ].map(
            ({ key, label: phaseLabel }) =>
              ytErrors[key] && (
                <div
                  key={key}
                  style={{
                    marginTop: 10,
                    padding: 10,
                    border: `1px solid ${T.primaryBorder}`,
                    background: T.primaryLight,
                    borderRadius: 4,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>
                    <strong>{phaseLabel} failed:</strong> {ytErrors[key]}
                  </div>
                  <button onClick={() => retryPhase(key)} disabled={ytBusy} style={{ ...btnGhost, padding: '6px 12px', fontSize: 11 }}>
                    Retry {phaseLabel.toLowerCase()}
                  </button>
                </div>
              )
          )}

          {ytVideoId && !ytErrors.upload && (
            <div style={{ marginTop: 14, fontSize: 13, fontFamily: FONT.ui, color: T.text }}>
              {ytScheduleMode === 'schedule' ? (
                <>⏱ Scheduled — processing, check YouTube Studio.</>
              ) : (
                <>
                  ✓{' '}
                  <a href={`https://youtube.com/watch?v=${ytVideoId}`} target="_blank" rel="noreferrer" style={{ color: T.primary }}>
                    View on YouTube →
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
