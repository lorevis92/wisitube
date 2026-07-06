import React, { useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { loadImage, decodeAudio, buildImageUrl } from '../lib/pollinations';
import { playTimeline } from '../lib/engine';
import { renderToMp4, WebCodecsUnsupportedError } from '../lib/exporter';

export default function ExportStep({ project, settings, isMobile }) {
  const canvasRef = useRef(null);
  const controllerRef = useRef(null);
  const abortRef = useRef(null);
  const [rendering, setRendering] = useState(false);
  const [pct, setPct] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
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

  async function renderVideo() {
    setError('');
    setVideoUrl('');
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
    try {
      const concept = project.thumbnails[thumbIdx];
      const url = buildImageUrl(
        `${concept.image_prompt}, YouTube thumbnail style, bold colors, high contrast, dramatic, eye catching`,
        { width: 1280, height: 720, seed: thumbSeed }
      );
      const img = await loadImage(url);
      await document.fonts.ready;
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
    </div>
  );
}
