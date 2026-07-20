import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { loadImage, decodeAudio } from '../lib/pollinations';
import { playTimeline } from '../lib/engine';
import { WebCodecsUnsupportedError } from '../lib/exporter';
import { uploadMedia, downloadMediaAsBlob } from '../lib/mediaStorage';
import { generateThumbnail } from '../lib/thumbnailEngine';
import { uploadVideo, setThumbnail, setCaptions, addToSeriesPlaylist } from '../lib/youtubePublishEngine';
import { renderVideoForExport } from '../lib/videoRenderEngine';

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

export default function ExportStep({ project, setProject, settings, channel, channelId, videoId, userId, isMobile }) {
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
  const [thumbBackupFailed, setThumbBackupFailed] = useState(false);

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

  // Same idea for the thumbnail — project.thumbnailStoragePath survives a refresh even though the
  // canvas itself (and any in-memory Blob) doesn't, so redraw it from the Supabase Storage backup
  // instead of forcing a full (paid, for premium providers) regeneration.
  useEffect(() => {
    if (thumbReady || !project.thumbnailStoragePath) return;
    (async () => {
      try {
        const blob = await downloadMediaAsBlob(project.thumbnailStoragePath);
        const img = await loadImage(URL.createObjectURL(blob));
        const ctx = thumbCanvasRef.current.getContext('2d');
        ctx.drawImage(img, 0, 0, 1280, 720);
        setThumbReady(true);
      } catch (err) {
        console.error('[mediaStorage] could not restore thumbnail from storage', project.thumbnailStoragePath, err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reference photos are stripped before every save like every other media Blob (see
  // stripBlobsForSync in src/lib/db.js) — back up any that still only have the in-memory Blob from
  // this session and haven't been uploaded yet. A no-op for videos with no references, and for ones
  // already backed up (storagePath already set).
  useEffect(() => {
    if (!userId) return;
    (project.references || []).forEach(async (ref) => {
      if (!ref.file || ref.storagePath) return;
      try {
        const storagePath = await uploadMedia(userId, videoId, 'reference', ref.id, ref.file);
        setProject((p) => ({
          ...p,
          references: (p.references || []).map((r) => (r.id === ref.id ? { ...r, storagePath } : r)),
        }));
      } catch (err) {
        console.error('[mediaStorage] failed to back up reference photo', ref.id, err);
      }
    });
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
      let blob, ext;
      try {
        blob = await renderVideoForExport(project, settings, {
          onProgress: (frameIndex, totalFrames) => setPct(Math.min(100, Math.round((frameIndex / totalFrames) * 100))),
          signal: controller.signal,
        });
        ext = 'mp4';
      } catch (e) {
        if (!(e instanceof WebCodecsUnsupportedError)) throw e;
        // Fast path unavailable in this browser — fall back to the original real-time recorder,
        // which needs a live, DOM-mounted canvas to captureStream() from (canvasRef below) —
        // rebuilding items here is cheap: loadImage/decodeAudio both cache by URL, so this just
        // re-reads what renderVideoForExport already resolved a moment ago.
        setUsingFallback(true);
        setPct(0);
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

  async function makeThumbnail() {
    setThumbBusy(true);
    setThumbReady(false);
    setThumbBackupFailed(false);
    try {
      const thumbBlob = await generateThumbnail(project, {
        settings,
        channelId,
        userId,
        videoId,
        thumbIdx,
        overlayText: thumbText,
        seed: thumbSeed,
      });

      // Draw the finished Blob onto the visible preview canvas — same pattern the "restore from
      // Supabase Storage on resume" effect above already uses, so downloadThumb()/runThumbnail()
      // (both of which read from thumbCanvasRef) keep working unchanged.
      const img = await loadImage(URL.createObjectURL(thumbBlob));
      const ctx = thumbCanvasRef.current.getContext('2d');
      ctx.drawImage(img, 0, 0, 1280, 720);
      setThumbReady(true);

      // Back up to Supabase Storage so this survives a refresh — never blocks the generation
      // itself, the canvas above is already usable this session regardless.
      try {
        const storagePath = await uploadMedia(userId, videoId, 'thumbnail', 'thumbnail', thumbBlob);
        setProject((p) => ({ ...p, thumbnailStoragePath: storagePath }));
        setThumbBackupFailed(false);
      } catch (err) {
        console.error('[mediaStorage] failed to back up thumbnail', err);
        setThumbBackupFailed(true);
      }
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
  // The actual sequence now lives in src/lib/youtubePublishEngine.js — these wrappers just resolve
  // this component's own state (videoBlob, thumbnail Blob, metadata) and translate its onProgress
  // events into the same setYtErrors/setYtUploadPct/setYtVideoId calls this file always made.

  function handleYtProgress(evt) {
    if (evt.kind === 'upload-progress') setYtUploadPct(evt.percent);
    else if (evt.kind === 'video-id') setYtVideoId(evt.videoId);
    else if (evt.kind === 'error') setYtErrors((prev) => ({ ...prev, [evt.phase]: evt.message }));
    else if (evt.kind === 'error-clear') setYtErrors((e) => ({ ...e, [evt.phase]: null }));
  }

  function buildYtMetadata() {
    return {
      title: ytTitle,
      description: ytDescription,
      tags: ytTags.split(',').map((t) => t.trim()).filter(Boolean),
      categoryId: ytCategory,
      language: YOUTUBE_LANGUAGE_CODES[settings.language] || 'en',
      privacyStatus: ytPrivacy,
      scheduleMode: ytScheduleMode,
      publishAt: ytPublishAt,
      madeForKids: ytMadeForKids,
      uploadCaptions: ytUploadCaptions,
      addToPlaylist: ytAddToPlaylist,
    };
  }

  async function runUpload() {
    // Never re-fetch videoUrl (a blob: URL) here — it's known to go invalid across
    // navigations/idle time even while the string itself still looks fine, which is what caused
    // "Failed to fetch" with no request ever reaching googleapis.com. Use the Blob already in
    // memory from this session's render, or the one restored from IndexedDB on resume (see the
    // mount effect above) — never a re-fetch of the transient URL.
    const videoBlob = renderedBlob || project.renderedVideoBlob;
    return uploadVideo(project, videoBlob, { channel, metadata: buildYtMetadata(), onProgress: handleYtProgress });
  }

  async function runThumbnail(videoId) {
    // no custom thumbnail made — YouTube's auto-picked one applies; skip the toBlob() call entirely.
    const thumbBlob = thumbReady ? await new Promise((resolve) => thumbCanvasRef.current.toBlob(resolve, 'image/png')) : null;
    return setThumbnail(videoId, thumbBlob, { channel, onProgress: handleYtProgress });
  }

  async function runCaptions(videoId) {
    return setCaptions(videoId, project, { channel, metadata: buildYtMetadata(), onProgress: handleYtProgress });
  }

  async function runPlaylist(videoId) {
    return addToSeriesPlaylist(videoId, project, { channel, metadata: buildYtMetadata(), onProgress: handleYtProgress });
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
        {thumbBackupFailed && (
          <div style={{ fontSize: 11, color: T.primary, fontFamily: FONT.ui, marginTop: 8 }}>
            ⚠ Not backed up — this thumbnail will be lost on refresh unless you retry.
          </div>
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
