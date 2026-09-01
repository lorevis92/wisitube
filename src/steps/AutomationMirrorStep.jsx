import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, mono } from '../theme';
import { listIncompleteVideos, listRecentCompletedVideos, loadVideo, persistVideoMediaProgress, deleteVideo, loadChannel, resetStuckVideo } from '../lib/db';
import { resumePendingBatches } from '../lib/batchResumption';
import { getRecipeForContentType, logStep } from '../lib/automationEngine';
import { runManagedResume } from '../lib/automationScheduler';
import { planMediaCleanup, runMediaCleanup, ARCHIVE_AFTER_DAYS } from '../lib/mediaArchival';

// Permanent status dashboard for automation — no longer just a temporary mirror that appears while
// a run is active. Three parts, in order:
//   1. The live, real-time mirror below — only rendered while `run` (App.jsx's
//      currentAutomationRun) is non-null, unchanged from before.
//   2. "Videos in progress" — every video whose listing thumbnail isn't created yet (src/lib/db.js's
//      listIncompleteVideos), always present regardless of whether a run is live.
//   3. "Recently completed" — the last 10 videos whose thumbnail IS created, published or not, with
//      a per-row "✓ Published" / "◻ Finished — not published" badge. Collapsed by default.
const PHASE_LABELS = {
  starting: 'Starting run',
  suggestion: 'Choosing a topic',
  'video-record': 'Creating video record',
  outline: 'Writing outline',
  scenes: 'Writing scenes',
  media: 'Generating images & voiceover',
  render: 'Rendering video',
  thumbnail: 'Creating thumbnail',
  youtube: 'Publishing to YouTube',
};

const LOG_PHASES = new Set(['starting', 'suggestion', 'video-record', 'outline', 'scenes']);

// Exported so App.jsx's Navbar idle-video-count badge polls listIncompleteVideos at the exact same
// cadence this page's own dashboard lists ("Videos in progress" / "Recently completed") do — one
// shared constant, never two numbers that could quietly drift apart.
export const INCOMPLETE_POLL_MS = 30000;

// Same status-dot logic as StoryboardStep.jsx's own statusDot, minus the title tooltip (there's no
// error text worth surfacing here since this view has no retry button to act on it anyway).
function statusDot(st) {
  return (
    <span
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
}

// The user explicitly wants exact date/time here, not a relative "3h ago" — same
// toLocaleString() convention already used for this elsewhere (e.g. automationScheduler.js's
// stale-lock diagnostics).
function formatDateTime(ts) {
  return ts ? new Date(ts).toLocaleString() : 'unknown time';
}

// Concrete progress readout for one row, built from listIncompleteVideos' `counts` — only the
// counts relevant to the video's CURRENT phase are meaningful (e.g. image counts mean nothing while
// still writing scenes), so this only ever shows something for the two phases that have real
// sub-progress to report. Returns null for the others (suggestion/render/thumbnail — phaseLabel
// alone already says everything there is to say).
function formatCountsDetail(item) {
  const c = item.counts;
  if (!c) return null;
  if (item.phase === 'scenes') return `${c.scenesWritten}/${c.scenesTotal} scenes written`;
  if (item.phase === 'media') {
    if (item.isStaticBackground) return `${c.audioReady}/${c.audioTotal} scenes with audio ready`;
    const audioPart = c.audioTotal > 0 && c.audioReady === c.audioTotal ? 'audio complete' : `${c.audioReady}/${c.audioTotal} audio ready`;
    return `${c.imagesReady}/${c.imagesTotal} images ready · ${audioPart}`;
  }
  return null;
}

// Explains WHY a video isn't moving right now (waitingReason, see db.js's listIncompleteVideos),
// distinct from WHERE it is (phaseLabel above it).
function formatWaitingReason(item) {
  if (item.waitingReason === 'awaiting_batch') return "⏳ Waiting on Google's batch processing";
  if (item.waitingReason === 'stuck') return item.stuckMessage || '⚠ Stuck — needs manual review';
  return '⏸ Idle — not part of an active cycle right now';
}

export default function AutomationMirrorStep({ run, userId, onResume, isMobile }) {
  const [incompleteVideos, setIncompleteVideos] = useState(null); // null = still loading
  const [completedVideos, setCompletedVideos] = useState(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  // One busy slot for the whole panel, not per-action — every per-video action (check/resume/
  // reset/delete) is mutually exclusive with every other action on that SAME row anyway (they all
  // end by reloading the list), and only ever disables that row's own buttons (see the disabled
  // checks below, all gated on `busyVideoId === item.videoId`), never other rows.
  const [busyVideoId, setBusyVideoId] = useState(null);
  const [busyLabel, setBusyLabel] = useState('');
  // Storage cleanup panel (see src/lib/mediaArchival.js). cleanupPlan is the dry-run result shown
  // before anything is deleted; cleanupResult is the outcome of the real run.
  const [cleanupPlan, setCleanupPlan] = useState(null);
  const [cleanupResult, setCleanupResult] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState('');

  async function loadIncomplete() {
    try {
      const items = await listIncompleteVideos(userId);
      setIncompleteVideos(items);
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to load incomplete videos', err);
    }
  }

  async function loadCompleted() {
    try {
      const items = await listRecentCompletedVideos(userId, 10);
      setCompletedVideos(items);
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to load recently completed videos', err);
    }
  }

  // Both lists refresh on a fixed interval regardless of whether a run is live — a video can be
  // sitting on Gemini Batch jobs, or simply mid-phase from an earlier interrupted session, and its
  // persisted state changes underneath this view (a background cycle advancing it, batch jobs
  // resolving) with nothing here to trigger a re-read. Without this the dashboard could show
  // hours-old counts ("0/80 scenes" long after they finished) until a manual action or a full
  // reload. Also refreshes the instant the tab regains visibility/focus: a backgrounded tab has its
  // setInterval throttled hard by the browser (to ~once a minute, and paused entirely while the
  // machine sleeps), so the interval alone isn't enough to keep a re-focused tab current.
  useEffect(() => {
    const refresh = () => {
      loadIncomplete();
      loadCompleted();
    };
    refresh();
    const id = setInterval(refresh, INCOMPLETE_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Moved here from AutomationStep.jsx's old "Batches in flight" panel — same function, same
  // resumePendingBatches call, just triggered from a "Videos in progress" row instead. Re-loads the
  // full video record (the dashboard list only carries display fields, not the whole
  // scenes/pendingImageBatches payload), checks its Gemini Batch jobs for anything newly ready, and
  // persists whatever resumePendingBatches downloaded.
  async function checkVideoForUpdates(item) {
    setBusyVideoId(item.videoId);
    setBusyLabel('Checking…');
    try {
      const video = await loadVideo(item.videoId);
      if (!video) return;
      await resumePendingBatches(video, {
        userId,
        videoId: item.videoId,
        channelId: item.channelId,
        settings: { style: item.style, imageProvider: item.imageProvider },
        // Merge-persist: the automation cycle may be resolving this same video's batches right now.
        persist: (p) => persistVideoMediaProgress(p),
      });
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to check batch updates for video', item.videoId, err);
      window.alert(`Could not check for updates on "${item.displayTitle}": ${String(err.message || err)}`);
    } finally {
      setBusyVideoId(null);
      loadIncomplete();
    }
  }

  // "Resume now" — runs just this one video's next phase (and however many follow, in the same
  // call — see the recipes' shouldRunPhase gating) via the channel's own recipe with targetVideoId
  // set, so the recipe touches ONLY this video (never findResumableVideo, never the per-channel
  // exhaustion loop). Routed through runManagedResume so it takes the SAME currently_running lock a
  // scheduled cycle takes: the two are now mutually exclusive. Before this, the manual resume ran
  // completely outside the lock, so a scheduler tick firing at the same instant would start a full
  // runAutomationCycle that resumed other videos on the same channel (and could double-submit
  // Gemini Batch chunks for this very one) — one click appearing to start several videos at once.
  async function resumeVideoNow(item) {
    setBusyVideoId(item.videoId);
    setBusyLabel('Resuming…');
    try {
      const channel = await loadChannel(item.channelId);
      if (!channel) throw new Error('Channel not found');
      const recipe = getRecipeForContentType(channel.content_type);
      if (!recipe) throw new Error(`No recipe available for content_type "${channel.content_type || '(none)'}"`);
      const result = await runManagedResume(() => recipe(channel, { userId, logStep, targetVideoId: item.videoId }));
      if (!result.started) {
        window.alert(`Can't resume "${item.displayTitle}" right now — ${result.reason}`);
      }
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to resume video', item.videoId, err);
      window.alert(`Could not resume "${item.displayTitle}": ${String(err.message || err)}`);
    } finally {
      setBusyVideoId(null);
      loadIncomplete();
      loadCompleted();
    }
  }

  // "Reset & retry" — clears the stuck marker (db.js's resetStuckVideo) so this video is eligible
  // for automatic resumption again and "Resume now" stops being disabled for it.
  async function resetAndRetry(item) {
    setBusyVideoId(item.videoId);
    setBusyLabel('Resetting…');
    try {
      await resetStuckVideo(item.videoId);
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to reset stuck video', item.videoId, err);
      window.alert(`Could not reset "${item.displayTitle}": ${String(err.message || err)}`);
    } finally {
      setBusyVideoId(null);
      loadIncomplete();
    }
  }

  // "Open in Storyboard" — same onResume(record) mechanism ChannelDashboardStep.jsx's own "Resume"
  // button already uses (App.jsx's handleResume), just fed a freshly-loaded full record here since
  // the dashboard list only carries display fields.
  async function openInStoryboard(item) {
    try {
      const video = await loadVideo(item.videoId);
      if (!video) throw new Error('Video not found');
      onResume?.(video);
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to open video', item.videoId, err);
      window.alert(`Could not open "${item.displayTitle}": ${String(err.message || err)}`);
    }
  }

  // "Delete" — same confirm text and deleteVideo call as ChannelDashboardStep.jsx's own
  // handleDeleteVideo.
  async function deleteVideoRow(item) {
    if (!window.confirm('Delete this video? This cannot be undone.')) return;
    setBusyVideoId(item.videoId);
    setBusyLabel('Deleting…');
    try {
      await deleteVideo(item.videoId);
    } catch (err) {
      console.error('[AutomationMirrorStep] failed to delete video', item.videoId, err);
      window.alert(`Could not delete "${item.displayTitle}": ${String(err.message || err)}`);
    } finally {
      setBusyVideoId(null);
      loadIncomplete();
    }
  }

  async function checkCleanup() {
    setCleanupBusy(true);
    setCleanupError('');
    setCleanupResult(null);
    try {
      setCleanupPlan(await planMediaCleanup(userId));
    } catch (err) {
      console.error('[AutomationMirrorStep] cleanup dry-run failed', err);
      setCleanupError(String(err?.message || err));
    } finally {
      setCleanupBusy(false);
    }
  }

  async function doCleanup() {
    if (!cleanupPlan || cleanupPlan.totalVideos === 0) return;
    if (
      !window.confirm(
        `Archive ${cleanupPlan.totalVideos} published video(s)?\n\n` +
          `This permanently deletes ${cleanupPlan.totalFiles} media file(s) (~${cleanupPlan.totalBytesLabel}) from Storage — ` +
          `scene images, audio and the rendered MP4. The videos stay on YouTube; the dashboard keeps its thumbnail and title. ` +
          `They can no longer be opened in Storyboard/Editor.`
      )
    )
      return;
    setCleanupBusy(true);
    setCleanupError('');
    try {
      const result = await runMediaCleanup(userId, { dryRun: false });
      setCleanupResult(result);
      setCleanupPlan(null);
      loadCompleted();
      loadIncomplete();
    } catch (err) {
      console.error('[AutomationMirrorStep] cleanup run failed', err);
      setCleanupError(String(err?.message || err));
    } finally {
      setCleanupBusy(false);
    }
  }

  const phaseLabel = run ? PHASE_LABELS[run.phase] || run.phase || '—' : '';
  const renderPct = run?.phase === 'render' ? parseInt(run.phaseDetail, 10) || 0 : 0;
  // Driven by observed state (project.pendingImageBatches), not channel config this view has no
  // access to — as soon as the media phase has actually submitted a Gemini Batch job for this
  // video, this is true; before that first submission (or for every other provider) it's false and
  // the ordinary per-scene grid below renders instead.
  const isBatchMode = run?.phase === 'media' && (run?.project?.pendingImageBatches || []).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{ fontFamily: FONT.display, fontSize: 26, color: T.text }}>Automation status</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginTop: 6, lineHeight: 1.6, maxWidth: 640 }}>
          {run ? (
            <>
              Read-only mirror of the automated run currently in progress on <strong>{run.channelName}</strong>, plus every other video
              mid-generation across every channel below.
            </>
          ) : (
            'Every video currently mid-generation across every channel, and what recently finished — nothing here is live right now, but this page always reflects the real state.'
          )}
        </div>
      </div>

      {run && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div style={label}>Current phase</div>
              <span style={{ ...mono, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: T.primary }}>{phaseLabel}</span>
            </div>
            {run.phaseDetail && <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 8 }}>{run.phaseDetail}</div>}
          </div>

          {run.phase === 'render' && (
            <div style={card}>
              <div style={label}>Render progress</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${renderPct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
                </div>
                <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{renderPct}%</span>
              </div>
            </div>
          )}

          {isBatchMode &&
            run.project?.scenes &&
            (() => {
              const allBeats = run.project.scenes.flatMap((s, sceneIdx) => (s.images || []).map((im, beatIndex) => ({ ...im, sceneIdx, beatIndex })));
              const readyBeats = allBeats.filter((b) => b.status === 'ready');
              const pct = allBeats.length ? Math.round((readyBeats.length / allBeats.length) * 100) : 0;
              return (
                <div style={card}>
                  <div style={label}>Gemini Batch — images in progress</div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 10 }}>
                    {readyBeats.length} of {allBeats.length} images ready — batch jobs in progress, may take up to a few hours
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: T.primary, transition: 'width 0.3s' }} />
                    </div>
                    <span style={{ ...mono, fontSize: 12, color: T.textSecondary }}>{pct}%</span>
                  </div>
                  {readyBeats.length > 0 && (
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
                        {readyBeats.map((b) => (
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
            })()}

          {run.phase === 'media' && run.project?.scenes && !isBatchMode && (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
              {run.project.scenes.map((scene, i) => (
                <div key={scene.id} style={{ ...card, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ ...label, color: T.text }}>
                      Scene <span style={mono}>{String(i + 1).padStart(2, '0')}</span>
                    </span>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>
                      {(scene.images || []).map((im, b) => (
                        <span key={im.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          {statusDot(im.status)} img{b + 1}
                        </span>
                      ))}
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {statusDot(scene.audioStatus)} voice
                      </span>
                      {scene.audioDuration ? <span style={mono}>{scene.audioDuration.toFixed(1)}s</span> : null}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                    {(scene.images || []).map((beat, b) => (
                      <div
                        key={beat.id}
                        style={{
                          position: 'relative',
                          borderRadius: 4,
                          overflow: 'hidden',
                          border: `1px solid ${T.border}`,
                          background: T.surfaceAlt,
                          aspectRatio: '16/9',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {beat.status === 'ready' && beat.url ? (
                          <img src={beat.url} alt={`Scene ${i + 1} · beat ${b + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <span
                            style={{
                              fontSize: 10,
                              color: T.textMuted,
                              fontFamily: FONT.ui,
                              textTransform: 'uppercase',
                              textAlign: 'center',
                              padding: 4,
                              animation: beat.status === 'loading' ? 'wisiPulse 1.2s infinite' : 'none',
                            }}
                          >
                            {beat.status === 'loading' ? 'Drawing…' : beat.status === 'error' ? 'Failed' : `Beat ${b + 1}`}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {LOG_PHASES.has(run.phase) && (run.log || []).length > 0 && (
            <div style={card}>
              <div style={label}>Live log</div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {run.log
                  .slice()
                  .reverse()
                  .map((entry, i) => (
                    <div key={i} style={{ ...mono, fontSize: 12, color: T.textSecondary }}>
                      <span style={{ color: T.textMuted }}>{PHASE_LABELS[entry.phase] || entry.phase}:</span> {entry.message}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {(run.phase === 'thumbnail' || run.phase === 'youtube') && (
            <div style={card}>
              <div style={label}>{phaseLabel}</div>
              <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 8 }}>{run.phaseDetail || 'In progress…'}</div>
            </div>
          )}
        </>
      )}

      {/* Always present, regardless of whether a run is live — see src/lib/db.js's
          listIncompleteVideos. */}
      <div style={card}>
        <div style={label}>Videos in progress</div>
        {incompleteVideos === null ? (
          <div style={{ ...mono, fontSize: 12, color: T.textMuted, marginTop: 10 }}>Loading…</div>
        ) : incompleteVideos.length === 0 ? (
          <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 10 }}>Nothing in progress right now.</div>
        ) : (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {incompleteVideos.map((item) => {
              const rowBusy = busyVideoId === item.videoId;
              const anyBusy = busyVideoId !== null;
              const countsDetail = formatCountsDetail(item);
              return (
                <div
                  key={item.videoId}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    border: `1px solid ${item.stuck ? T.primaryBorder : T.border}`,
                    background: item.stuck ? T.primaryLight : 'transparent',
                    borderRadius: 4,
                    padding: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: FONT.ui, fontSize: 13, fontWeight: 700, color: T.text }}>{item.displayTitle}</div>
                    <div style={{ ...mono, fontSize: 11, color: item.stuck ? T.primary : T.textSecondary, marginTop: 4 }}>
                      {item.channelName} · {item.phaseLabel}
                    </div>
                    {countsDetail && <div style={{ ...mono, fontSize: 11, color: T.textSecondary, marginTop: 2 }}>{countsDetail}</div>}
                    <div style={{ fontFamily: FONT.ui, fontSize: 11, color: item.waitingReason === 'stuck' ? T.primary : T.textSecondary, marginTop: 4 }}>
                      {formatWaitingReason(item)}
                    </div>
                    <div style={{ ...mono, fontSize: 10, color: T.textMuted, marginTop: 4 }}>started {formatDateTime(item.createdAt)}</div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                      onClick={() => openInStoryboard(item)}
                      disabled={anyBusy}
                      style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: anyBusy ? 0.6 : 1 }}
                    >
                      Open in Storyboard
                    </button>

                    {item.waitingReason === 'awaiting_batch' && (
                      <button
                        onClick={() => checkVideoForUpdates(item)}
                        disabled={anyBusy}
                        style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: anyBusy ? 0.6 : 1 }}
                      >
                        🔄 Check for updates
                      </button>
                    )}

                    {item.waitingReason !== 'awaiting_batch' && (
                      <button
                        onClick={() => resumeVideoNow(item)}
                        disabled={anyBusy || item.waitingReason === 'stuck'}
                        title={item.waitingReason === 'stuck' ? 'Reset & retry first — this video has failed the same phase too many times in a row' : undefined}
                        style={{ ...btnPrimary, padding: '6px 10px', fontSize: 10, opacity: anyBusy || item.waitingReason === 'stuck' ? 0.6 : 1 }}
                      >
                        ▶ Resume now
                      </button>
                    )}

                    {item.waitingReason === 'stuck' && (
                      <button
                        onClick={() => resetAndRetry(item)}
                        disabled={anyBusy}
                        style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: anyBusy ? 0.6 : 1 }}
                      >
                        🔁 Reset &amp; retry
                      </button>
                    )}

                    <button
                      onClick={() => deleteVideoRow(item)}
                      disabled={anyBusy}
                      style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder, padding: '6px 10px', fontSize: 10, opacity: anyBusy ? 0.6 : 1 }}
                    >
                      🗑 Delete
                    </button>

                    {rowBusy && <span style={{ ...mono, fontSize: 10, color: T.textMuted }}>{busyLabel}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Collapsed by default, closed = default state per the request. */}
      <div style={card}>
        <button
          onClick={() => setCompletedOpen((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
          }}
        >
          <span style={label}>Recently completed (last 10)</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {completedOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>
        {completedOpen && (
          <div style={{ marginTop: 14 }}>
            {completedVideos === null ? (
              <div style={{ ...mono, fontSize: 12, color: T.textMuted }}>Loading…</div>
            ) : completedVideos.length === 0 ? (
              <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary }}>No completed videos yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {completedVideos.map((item) => (
                  <div
                    key={item.videoId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                      border: `1px solid ${T.border}`,
                      borderRadius: 4,
                      padding: 10,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: FONT.ui, fontSize: 13, fontWeight: 700, color: T.text }}>{item.displayTitle}</div>
                      <div style={{ ...mono, fontSize: 11, color: T.textSecondary, marginTop: 4 }}>
                        {item.channelName} · started {formatDateTime(item.createdAt)}
                      </div>
                      {item.thumbnailPublishFailed && (
                        <div style={{ ...mono, fontSize: 11, color: T.yellow, marginTop: 4 }}>
                          ⚠ Published without its custom thumbnail — open it in Export and retry the thumbnail step (no re-upload needed).
                        </div>
                      )}
                    </div>
                    {item.youtubeVideoId ? (
                      <a
                        href={`https://www.youtube.com/watch?v=${item.youtubeVideoId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...mono,
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: T.green,
                          border: `1px solid ${T.green}`,
                          borderRadius: 3,
                          padding: '4px 8px',
                          textDecoration: 'none',
                          flexShrink: 0,
                        }}
                      >
                        ✓ Published
                      </a>
                    ) : (
                      <span
                        title="The video is fully produced (render + thumbnail done) but was never published — auto-publish is off for this channel, or it's awaiting manual review after an anomalous interruption."
                        style={{
                          ...mono,
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: T.textMuted,
                          border: `1px solid ${T.border}`,
                          borderRadius: 3,
                          padding: '4px 8px',
                          flexShrink: 0,
                        }}
                      >
                        ◻ Finished — not published
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={label}>Storage cleanup</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 6, lineHeight: 1.6, maxWidth: 620 }}>
          Deletes the heavy media (scene images, audio, rendered MP4) of videos published more than {ARCHIVE_AFTER_DAYS} days ago to free
          Storage. The videos stay on YouTube and keep their thumbnail, title and metadata in the dashboard — they just can't be
          reopened in Storyboard/Editor afterwards. The daily automation cycle also runs this on its own.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button onClick={checkCleanup} disabled={cleanupBusy} style={{ ...btnGhost, opacity: cleanupBusy ? 0.6 : 1 }}>
            {cleanupBusy && !cleanupResult ? 'Checking…' : 'Check what can be cleaned up'}
          </button>
          {cleanupPlan && cleanupPlan.totalVideos > 0 && (
            <button onClick={doCleanup} disabled={cleanupBusy} style={{ ...btnPrimary, opacity: cleanupBusy ? 0.6 : 1 }}>
              {cleanupBusy ? 'Cleaning up…' : `Clean up ${cleanupPlan.totalVideos} video${cleanupPlan.totalVideos === 1 ? '' : 's'} (~${cleanupPlan.totalBytesLabel})`}
            </button>
          )}
        </div>

        {cleanupError && (
          <div style={{ ...mono, fontSize: 12, color: T.primary, marginTop: 10 }}>{cleanupError}</div>
        )}

        {cleanupPlan && (
          <div style={{ marginTop: 12 }}>
            {cleanupPlan.totalVideos === 0 ? (
              <div style={{ ...mono, fontSize: 12, color: T.textSecondary }}>Nothing eligible — no published video is older than {ARCHIVE_AFTER_DAYS} days and un-archived.</div>
            ) : (
              <>
                <div style={{ ...mono, fontSize: 12, color: T.text }}>
                  Dry run — would archive {cleanupPlan.totalVideos} video(s), removing {cleanupPlan.totalFiles} file(s), ~{cleanupPlan.totalBytesLabel}:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                  {cleanupPlan.videos.map((v) => (
                    <div key={v.videoId} style={{ ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {v.channelName} · {v.displayTitle}
                      </span>
                      <span style={{ flexShrink: 0 }}>{v.fileCount} file{v.fileCount === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {cleanupResult && !cleanupResult.dryRun && (
          <div style={{ ...mono, fontSize: 12, color: T.green, marginTop: 12 }}>
            Done — archived {cleanupResult.archived} video(s), freed ~{cleanupResult.freedBytesLabel}
            {cleanupResult.failed > 0 ? `, ${cleanupResult.failed} failed (see console/log)` : ''}.
          </div>
        )}
      </div>
    </div>
  );
}
