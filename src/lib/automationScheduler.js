// Unattended background scheduling for the automation cycle — a client-side "heartbeat" that
// periodically starts a real (non-dry-run) runAutomationCycle on its own, so the user doesn't have
// to remember to click "Run real cycle" in AutomationStep.jsx. Explicitly opt-in (enabled defaults
// to false — see db.js's wisitube_scheduler_settings) and only active while this browser tab stays
// open: there is no server-side cron here, this is a setInterval in the page, the same "tab must
// stay open" constraint already documented everywhere else in this codebase (Gemini Batch
// resumption, the wake lock held during generation, etc.).
//
// currently_running (persisted in wisitube_scheduler_settings, not just in-memory) is the single
// source of truth for "is a real cycle in flight right now, whoever started it" — shared between
// the scheduler's own tick and AutomationStep.jsx's manual "Run real cycle" button (both funnel
// through runManagedCycle below), so the two can never run a cycle concurrently, and a click on
// "Stop" always has something real to stop regardless of which one started it. Dry runs never go
// through here — they don't spend money or touch automation_daily_upload_count, so they have no
// need for the lock and keep using AutomationStep.jsx's own local stop ref exactly as before.
import { getSchedulerSettings, saveSchedulerSettings, logAutomationStep, getLastRealAutomationLogEntry, listIncompleteVideos, loadChannel } from './db';
import { runAutomationCycle, getRecipeForContentType, logStep } from './automationEngine';

const TICK_MS = 60 * 1000;

// The lightweight pending-batch poll (pollPendingImageBatches below) runs on its OWN fixed 60s
// timer, completely independent of the user-configured cycle interval (intervalValue/intervalUnit,
// e.g. every 6 hours) — a Gemini Batch job that finishes 20 minutes into a 6h gap should be picked
// up and carried through to render/thumbnail/publish within a minute, not sit idle until the next
// full cycle. Same cadence as TICK_MS, kept as its own named constant so the two can be tuned apart.
const BATCH_POLL_TICK_MS = 60 * 1000;
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

// Lock liveness — see withSchedulerLock. Whoever holds currently_running rewrites last_heartbeat_at
// every HEARTBEAT_INTERVAL_MS for as long as it's working; if that signal goes quiet for
// HEARTBEAT_STALE_MS the holder's tab is gone (closed, asleep, crashed) or its event loop is wedged,
// and the lock is orphaned — the next acquire attempt reclaims it. This works for EVERY lock holder
// identically (full cycle, single resume, the lightweight batch poll), all of which go through
// withSchedulerLock, and it also makes a failed release write below self-correcting: the heartbeat
// stops either way, so the lock never sits stuck longer than HEARTBEAT_STALE_MS.
//
// 3 min is ~6 missed 30s beats — long enough that a brief tab backgrounding / GC pause / slow
// network run of heartbeat writes doesn't trip it, short enough that a genuinely dead lock is
// reclaimed in minutes instead of the hours the old start-time threshold needed.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// Fallback only for a lock acquired before last_heartbeat_at existed (heartbeat is null, so there's
// nothing recent to judge liveness by) — the original "started this long ago" heuristic. A real
// cycle can legitimately run a couple hours, hence still generous.
const LEGACY_STALE_LOCK_MS = 4 * 60 * 60 * 1000;

function intervalMs(settings) {
  const unitMs = UNIT_MS[settings.intervalUnit] || UNIT_MS.hours;
  return Math.max(1, Number(settings.intervalValue) || 1) * unitMs;
}

function formatElapsed(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHr < 24) return `${totalHr}h ${remMin}m`;
  const days = Math.floor(totalHr / 24);
  const remHr = totalHr % 24;
  return `${days}d ${remHr}h`;
}

// Is the currently_running lock in `settings` orphaned? Judged by the heartbeat's age
// (HEARTBEAT_STALE_MS) when there is one, falling back to the lock's start time + the legacy
// multi-hour threshold only for a lock acquired before last_heartbeat_at existed. Shared by
// withSchedulerLock (which acts on it) and pollPendingImageBatches (which must not skip a round on
// a lock that's actually dead). Callers should have already checked settings.currentlyRunning.
function lockStaleness(settings) {
  const heartbeatAt = settings.lastHeartbeatAt || null;
  const startedAt = settings.currentRunStartedAt || null;
  const heartbeatAgeMs = heartbeatAt ? Date.now() - heartbeatAt : null;
  const startAgeMs = startedAt ? Date.now() - startedAt : null;
  const stale =
    heartbeatAgeMs !== null
      ? heartbeatAgeMs > HEARTBEAT_STALE_MS
      : startAgeMs !== null && startAgeMs > LEGACY_STALE_LOCK_MS;
  return { stale, heartbeatAt, startedAt, heartbeatAgeMs, startAgeMs };
}

// Release the currently_running lock, retrying a failed write a couple times before giving up — a
// single lost release used to orphan the lock until the stale threshold. Even if every attempt
// fails, the heartbeat has already stopped (see withSchedulerLock's finally), so the lock is still
// reclaimed within HEARTBEAT_STALE_MS; this just makes the clean path robust.
async function releaseLock(label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
      return;
    } catch (err) {
      console.error(`[automationScheduler] withSchedulerLock(${label}) failed to release the DB lock (attempt ${attempt}/3)`, err);
      // eslint-disable-next-line no-await-in-loop
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  console.error(
    `[automationScheduler] withSchedulerLock(${label}) gave up releasing the DB lock — the heartbeat has stopped, so the stale check will reclaim it within ${Math.round(
      HEARTBEAT_STALE_MS / 60000
    )} min.`
  );
}

// Turns automationEngine.js's { channelId, channelName, step, message, videoId, project } onProgress
// events into the shape App.jsx's currentAutomationRun / AutomationMirrorStep.jsx expect. Shared
// (rather than duplicated) between AutomationStep.jsx's own manual-run wiring and App.jsx's
// scheduler wiring below, since both need to feed the exact same mirror state the exact same way.
export function applyProgressToRun(prev, evt) {
  const sameChannel = prev && prev.channelId === evt.channelId;
  const log = [...(sameChannel ? prev.log || [] : []), { ts: Date.now(), phase: evt.step, message: evt.message }].slice(-40);
  return {
    channelId: evt.channelId,
    channelName: evt.channelName,
    videoId: evt.videoId ?? (sameChannel ? prev.videoId : null),
    phase: evt.step,
    phaseDetail: evt.message,
    project: evt.project ?? (sameChannel ? prev.project : null),
    log,
  };
}

// Shared stop flag — set by AutomationStep.jsx's "Stop" button regardless of who started the
// in-flight cycle (the scheduler's tick, or that same component's own manual "Run real cycle"). A
// plain module-level variable rather than React state: runAutomationCycle polls shouldStop() from
// inside a plain async function, not a component render, so React state would only add
// re-render overhead for no benefit — same reasoning AutomationStep.jsx's own stopRequestedRef
// already uses a ref for.
let stopRequested = false;
export function requestStop() {
  stopRequested = true;
}

// Guards against two runManagedCycle calls overlapping within the SAME browser tab in the instant
// before the DB round-trip that sets currently_running has resolved (e.g. the 60s tick firing again
// right as a manual click starts one) — the persisted currently_running flag is the
// cross-tab/cross-session guard; this is the same-tab, same-instant guard that a flag which can
// only be checked-then-set with an await in between can't provide on its own.
let claimedLocally = false;

/**
 * The one place a real automation cycle is ever started from, whether by the scheduler's own tick
 * or AutomationStep.jsx's manual "Run real cycle" button — unifies the currently_running lock and
 * the shared stop flag so the two trigger paths can never run concurrently and "Stop" always works
 * regardless of which one is in flight.
 *
 * Returns { started: false, reason } immediately, without calling runAutomationCycle at all, when
 * another cycle is already in flight AND it's been running less than STALE_LOCK_HOURS — reason is a
 * full, human-readable diagnostic (how long the blocking cycle has been running, and its most
 * recent known log line if one can be found) so whoever reads it — the 'scheduler'/'blocked' log
 * row this function's caller writes, or an alert shown from a blocked manual click — understands
 * immediately why nothing happened, without having to go dig through automation_daily_upload_count
 * or query anything else themselves.
 *
 * When the blocking lock's heartbeat has gone quiet (HEARTBEAT_STALE_MS — see withSchedulerLock),
 * the lock is instead presumed abandoned: the tab/computer that held it went away (closed, slept,
 * crashed, lost network) or its event loop wedged, so the heartbeat writes stopped. Auto-released
 * (logged as 'stale_lock_released', never as an ordinary success), and this same call falls through
 * to acquire the lock fresh, rather than waiting for a later tick to notice the lock is free.
 *
 * Returns { started: true } once runAutomationCycle has finished (successfully, with an error, an
 * inProgress:true "still waiting on Gemini Batch" result, or stopped) — the lock is always released
 * in a finally (with a retry — see releaseLock), and the heartbeat is stopped there first, so even
 * a total failure to write the release leaves the lock reclaimable within HEARTBEAT_STALE_MS. A tab
 * that vanishes mid-run is covered by the same heartbeat mechanism.
 */
export async function runManagedCycle({ userId, onUpdate, onProgress }) {
  return withSchedulerLock({ label: 'cycle', resetInterval: true }, ({ shouldStop }) =>
    runAutomationCycle({ userId, dryRun: false, onUpdate, onProgress, shouldStop })
  );
}

/**
 * Runs a single-video "Resume now" (AutomationMirrorStep.jsx) under the EXACT same currently_running
 * lock the scheduler's own cycle takes, so a manual resume and an automatic cycle can never overlap.
 * They used to run completely independently: resumeVideoNow bypassed the lock entirely, so a
 * scheduler tick firing at the same moment would start runAutomationCycle, whose findResumableVideo
 * + per-channel exhaustion loop would then resume OTHER videos on the same channel (and could even
 * double-submit Gemini Batch chunks for the very video being resumed by hand) — one click appearing
 * to "start several videos at once". `task` here is the caller's already-scoped
 * recipe(channel, { targetVideoId }) call — this function only adds the mutual exclusion, it never
 * touches which video runs. resetInterval is false: a manual resume must not push the next
 * scheduled cycle's timer out.
 *
 * Same return shape as runManagedCycle: { started: false, reason } if a cycle/resume is already in
 * flight (the caller should surface `reason` and do nothing), { started: true } once `task` settles.
 */
export async function runManagedResume(task) {
  return withSchedulerLock({ label: 'resume', resetInterval: false }, () => task());
}

async function withSchedulerLock({ label, resetInterval }, task) {
  console.warn(`[run-cycle-debug] withSchedulerLock(${label}) entered, claimedLocally =`, claimedLocally);
  if (claimedLocally) {
    console.warn(`[run-cycle-debug] withSchedulerLock(${label}) bailing out — claimedLocally is already true in this tab`);
    return { started: false, reason: 'another cycle claimed the lock in this same browser tab a moment ago — try again shortly' };
  }

  console.warn(`[run-cycle-debug] withSchedulerLock(${label}) about to call getSchedulerSettings()`);
  const settings = await getSchedulerSettings();
  console.warn('[run-cycle-debug] getSchedulerSettings() returned', settings);
  if (settings.currentlyRunning) {
    console.warn(`[run-cycle-debug] withSchedulerLock(${label}) bailing out — DB says currently_running is already true`, {
      currentRunStartedAt: settings.currentRunStartedAt,
      elapsedMs: settings.currentRunStartedAt ? Date.now() - settings.currentRunStartedAt : null,
    });
    const { stale, startedAt, heartbeatAt, heartbeatAgeMs } = lockStaleness(settings);
    const elapsedMs = startedAt ? Date.now() - startedAt : null;
    const elapsed = startedAt ? formatElapsed(elapsedMs) : 'an unknown amount of time';
    const startedAtText = startedAt ? new Date(startedAt).toLocaleString() : 'an unknown time';
    const heartbeatText = heartbeatAt
      ? `last heartbeat ${formatElapsed(heartbeatAgeMs)} ago`
      : 'no heartbeat recorded (lock predates the heartbeat mechanism)';
    let lastLineText = 'no recent automation log entry found to diagnose further';
    try {
      // Deliberately NOT listAutomationLog({ limit: 1 }) — that's a global "most recent row"
      // query, which once this branch itself starts writing step:'scheduler'/'blocked' rows every
      // tick would just keep finding its own last message (see getLastRealAutomationLogEntry's own
      // comment for the runaway-recursion bug that caused). This excludes those rows at the query
      // level so it always finds genuine cycle activity, regardless of how many blocked ticks have
      // piled up since.
      const l = await getLastRealAutomationLogEntry();
      if (l) {
        const ago = l.createdAt ? formatElapsed(Date.now() - l.createdAt) : 'an unknown time';
        lastLineText = `last known log line: channel ${l.channelId || '—'}, step "${l.step}" → ${l.status}${l.message ? ` ("${l.message}")` : ''}, ${ago} ago`;
      }
    } catch (err) {
      lastLineText = `could not read the automation log to diagnose further: ${String(err.message || err)}`;
    }

    // Orphaned lock — the holder's heartbeat has gone quiet (or, for a pre-heartbeat lock, it's
    // simply older than the legacy threshold). Auto-release and fall through to acquire fresh, so
    // this same tick recovers instead of the scheduler sitting idle until someone clicks
    // "Force unlock" (which is exactly what happened before this).
    if (stale) {
      const staleMessage = `stale lock auto-released (started ${startedAtText}, ${elapsed} ago; ${heartbeatText}) — ${lastLineText}`;
      console.warn('[automationScheduler] auto-releasing stale lock:', staleMessage);
      try {
        // A distinct status, never 'success' or 'blocked' — this must stay visibly different in the
        // history from an ordinary cycle outcome, since it's recovering from an abnormal shutdown,
        // not reporting one.
        await logAutomationStep(null, null, 'scheduler', 'stale_lock_released', staleMessage);
      } catch (err) {
        console.error('[automationScheduler] failed to log the stale-lock release', err);
      }
      try {
        await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
      } catch (err) {
        console.error('[automationScheduler] failed to release the stale lock', err);
        return { started: false, reason: `${staleMessage} — but releasing the lock itself failed: ${String(err.message || err)}` };
      }
      // Falls through — settings.currentlyRunning is now stale, not current, so the acquire-and-run
      // logic below proceeds exactly as if this had been a normal, unlocked tick.
    } else {
      return {
        started: false,
        reason: `an automation ${label === 'resume' ? 'cycle or resume' : 'cycle'} has been running for ${elapsed} (started ${startedAtText}; ${heartbeatText}) — ${lastLineText}`,
      };
    }
  }

  // BUG FIX: claimedLocally = true and the initial "acquire the lock" write used to sit BEFORE this
  // try/finally. If that write itself threw (a network drop, an expired session, anything) the
  // exception propagated straight out — claimedLocally was left stuck true for the rest of this
  // tab's lifetime (every later call, from the scheduler's own tick or a manual "Run real cycle"
  // click, would immediately hit the branch above and return its hardcoded "a moment ago" message
  // forever, regardless of how much real time had actually passed — that's exactly the stale-message
  // symptom this fix addresses), and if the write had actually landed server-side despite the
  // client-side failure (an ambiguous "committed but response lost" case), currently_running was
  // left stuck true in the database too, since the task — and the finally that releases the DB lock
  // — was never even reached. Wrapping the acquire itself in this try/finally guarantees
  // claimedLocally always gets released, whatever fails.
  console.warn(`[run-cycle-debug] withSchedulerLock(${label}) acquiring lock — claimedLocally = true`);
  claimedLocally = true;
  let heartbeatTimer = null;
  try {
    stopRequested = false;
    const startedAt = Date.now();
    // lastRunStartedAt drives the scheduler's interval timer — only a real cycle bumps it; a manual
    // single-video resume must not push the next scheduled cycle out. lastHeartbeatAt is written
    // SEPARATELY, just below, not in this acquire patch — so a deployment where the DB column isn't
    // there yet still acquires the lock cleanly and just degrades to the legacy stale threshold.
    const lockPatch = { currentlyRunning: true, currentRunStartedAt: startedAt };
    if (resetInterval) lockPatch.lastRunStartedAt = startedAt;
    console.warn(`[run-cycle-debug] withSchedulerLock(${label}) about to write currently_running=true to DB`);
    await saveSchedulerSettings(lockPatch);
    console.warn(`[run-cycle-debug] withSchedulerLock(${label}) wrote currently_running=true, about to run task()`);

    // Keep the liveness signal fresh for as long as this task runs. If this tab is closed / put to
    // sleep / its event loop wedged, these writes simply stop and another acquire attempt reclaims
    // the lock within HEARTBEAT_STALE_MS — regardless of which lock holder this is (cycle, resume,
    // batch poll), and regardless of whether the release below succeeds. Fire-and-forget: a single
    // failed write is retried on the next interval; a missing column (pre-migration) just leaves
    // lastHeartbeatAt null, which lockStaleness handles by falling back to the legacy threshold.
    const beat = () =>
      saveSchedulerSettings({ lastHeartbeatAt: Date.now() }).catch((err) =>
        console.error(`[automationScheduler] withSchedulerLock(${label}) heartbeat write failed (retrying next interval)`, err)
      );
    beat();
    heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

    try {
      await task({ shouldStop: () => stopRequested });
      console.warn(`[run-cycle-debug] withSchedulerLock(${label}) task() resolved normally`);
      return { started: true };
    } finally {
      // Runs whether the task resolved normally (success, a per-channel error already caught
      // internally, or a video left inProgress:true awaiting Gemini Batch — none of these are
      // exceptions, they're all just different normal return paths) or, in the unlikely case
      // something above it truly threw, on that exception too — inProgress:true never bypasses this.
      // Stop the heartbeat BEFORE releasing: if the release write then fails, the now-frozen
      // heartbeat guarantees the stale check reclaims the lock within HEARTBEAT_STALE_MS.
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      console.warn(`[run-cycle-debug] withSchedulerLock(${label}) finally — releasing DB lock (currently_running=false)`);
      await releaseLock(label);
      console.warn(`[run-cycle-debug] withSchedulerLock(${label}) DB lock release attempt done`);
    }
  } finally {
    console.warn(`[run-cycle-debug] withSchedulerLock(${label}) outer finally — claimedLocally = false`);
    claimedLocally = false;
  }
}

// Manual escape hatch for a lock that's genuinely stuck (see AutomationStep.jsx's "Force unlock"
// button) — for a lock whose heartbeat is somehow still being written by a runaway timer the
// automatic recovery above therefore won't touch, or simply when someone doesn't want to wait out
// even the (now short) heartbeat-stale window (e.g. the acquire write's response was lost after it
// had already committed server-side, leaving
// currently_running=true with no in-memory runManagedCycle call left anywhere to release it,
// including in another tab/session entirely, which this module's own claimedLocally guard can't see
// at all). Resets the DB lock only — never touches claimedLocally, which is scoped to whichever tab
// actually holds it, if any.
export async function forceUnlock() {
  await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
}

// Guards against a slow poll (a video whose batch just finished re-entering render → thumbnail →
// publish can take minutes) still working through its video list when the next 60s batch tick
// fires — same "one at a time within this tab" role claimedLocally plays for the full cycle.
let pollingBatches = false;

/**
 * Lightweight, independent poll for in-flight Gemini Batch jobs — the second heartbeat, separate
 * from the full automation cycle (tick/runManagedCycle) in every way that matters:
 *
 *  - Runs every BATCH_POLL_TICK_MS (60s), NOT on the user's configured cycle interval.
 *  - Touches ONLY videos that already have a non-empty pendingImageBatches (db.js's
 *    listIncompleteVideos → waitingReason 'awaiting_batch' / hasPendingBatches). It never starts a
 *    new video, never fetches a suggestion, never touches budget, daily counters or the program
 *    manager — its only effect is checking batch status and letting an already-started video
 *    continue once its images are all ready.
 *  - For each such video it calls the exact same per-video continuation
 *    AutomationMirrorStep.jsx's "Check for updates" button uses: runManagedResume(() =>
 *    recipe(channel, { targetVideoId })). The recipe re-enters the media phase, polls Google, and
 *    if every image is ready carries straight on to render → thumbnail → publish in the same call.
 *  - Takes the SAME currently_running lock (via runManagedResume) as a full cycle and a manual
 *    resume, so it can never overlap either. If the lock is held it stops for this round and the
 *    next 60s tick retries — nothing is logged for a blocked poll (unlike the full cycle's
 *    'scheduler'/'blocked' rows), since a batch poll being skipped is routine, not noteworthy.
 *  - Active automatically whenever "Enable unattended background mode" is on (its timer is started
 *    and stopped alongside the main one in startScheduler/stopSchedulerTimer) — no separate setting.
 */
async function pollPendingImageBatches({ userId }) {
  if (pollingBatches) return;

  let settings;
  try {
    settings = await getSchedulerSettings();
  } catch (err) {
    console.error('[automationScheduler] pending-batch poll: failed to read scheduler settings', err);
    return;
  }
  // The timer is only running while the scheduler is enabled, but re-check anyway — another tab may
  // have turned it off since this tab's timer was last (re)started.
  if (!settings.enabled) return;
  // A LIVE full cycle or manual action holds the lock — skip this round entirely (down to the DB
  // sweep below) and let the next 60s tick retry once it frees up. A STALE lock (dead holder, quiet
  // heartbeat) must NOT short-circuit here, or the poll would starve forever behind an orphaned
  // lock — fall through so runManagedResume → withSchedulerLock can auto-release and reclaim it.
  if (settings.currentlyRunning && !lockStaleness(settings).stale) return;

  let videos;
  try {
    videos = await listIncompleteVideos(userId);
  } catch (err) {
    console.error('[automationScheduler] pending-batch poll: failed to list incomplete videos', err);
    return;
  }
  const awaitingBatch = videos.filter((v) => v.hasPendingBatches);
  if (awaitingBatch.length === 0) return;

  pollingBatches = true;
  try {
    for (const item of awaitingBatch) {
      let channel;
      try {
        // eslint-disable-next-line no-await-in-loop
        channel = await loadChannel(item.channelId);
      } catch (err) {
        console.error('[automationScheduler] pending-batch poll: failed to load channel', item.channelId, err);
        continue;
      }
      if (!channel) continue;
      const recipe = getRecipeForContentType(channel.content_type);
      if (!recipe) {
        console.warn('[automationScheduler] pending-batch poll: no recipe for content_type', channel.content_type, '- skipping', item.videoId);
        continue;
      }
      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await runManagedResume(() => recipe(channel, { userId, logStep, targetVideoId: item.videoId }));
      } catch (err) {
        // The recipe threw (e.g. a video that resolves to "stuck", or a genuine phase failure).
        // withSchedulerLock's finally already released the lock before this propagated — just move
        // on to the next video so one bad video can't starve the rest of the sweep.
        console.error('[automationScheduler] pending-batch poll: resume threw for', item.videoId, err);
        continue;
      }
      if (!result.started) {
        // The lock was taken between the check above and here (a full cycle tick, a manual resume) —
        // stop and let the next batch tick retry the remaining videos.
        console.warn('[automationScheduler] pending-batch poll: lock unavailable mid-sweep, retrying next tick —', result.reason);
        break;
      }
    }
  } finally {
    pollingBatches = false;
  }
}

let timerId = null;
let batchTimerId = null;

// True once a tick has seen the configured interval elapse while another cycle still held the
// lock — from that point on, every 60s tick retries regardless of the interval timer, instead of
// waiting for intervalMs to elapse AGAIN from the same (by-then-stale) lastRunStartedAt, which
// would mean sitting silent for up to the full configured interval even after the blocking cycle
// had long since freed the lock. This used to happen implicitly, as a side effect of a blocked
// runManagedCycle attempt never writing lastRunStartedAt (so intervalElapsed just happened to stay
// true forever once it first became true) — correct in practice, but accidental: nothing made that
// retry-every-tick behavior an explicit, intentional state, and a future change to runManagedCycle's
// blocked branch could silently break it. This flag makes it explicit instead. Reset to false the
// moment a cycle actually starts (or the scheduler is disabled), so the ordinary interval wait
// resumes cleanly from the new lastRunStartedAt runManagedCycle just wrote.
let awaitingLockRelease = false;

async function tick({ userId, onUpdate, onProgress, onCycleEnd }) {
  let settings;
  try {
    settings = await getSchedulerSettings();
  } catch (err) {
    console.error('[automationScheduler] failed to read scheduler settings', err);
    return;
  }
  if (!settings.enabled) {
    awaitingLockRelease = false;
    return;
  }

  const intervalElapsed = !settings.lastRunStartedAt || Date.now() - settings.lastRunStartedAt >= intervalMs(settings);

  // Neither due on the ordinary interval schedule NOR mid-retry after an earlier block this cycle
  // (see awaitingLockRelease above) — genuinely nothing to do yet.
  if (!intervalElapsed && !awaitingLockRelease) return;

  const result = await runManagedCycle({ userId, onUpdate, onProgress });
  if (!result.started) {
    // The interval has elapsed (or we were already retrying) and the lock is still held elsewhere —
    // keep retrying every tick until it frees up, ignoring the interval timer from here on (see
    // awaitingLockRelease's header comment).
    awaitingLockRelease = true;
    // A global, not per-channel, diagnostic — see db.js's required "alter column channel_id drop
    // not null" note on wisitube_automation_log.
    await logAutomationStep(null, null, 'scheduler', 'blocked', result.reason).catch((err) =>
      console.error('[automationScheduler] failed to log a blocked scheduler tick', err)
    );
  } else {
    awaitingLockRelease = false;
    // Only clear the mirror for a cycle that actually ran (and was therefore the one being
    // mirrored) — a blocked attempt never touched onProgress/currentAutomationRun in the first
    // place, so there's nothing of this run's to clear (and doing so anyway could wipe out a
    // genuinely still-in-progress run if this tick and another trigger somehow overlapped).
    onCycleEnd?.();
  }
}

/**
 * Starts the 60s heartbeat — checked every 60s regardless of the configured interval, purely so a
 * settings change (enabling the scheduler, or shortening the interval) takes effect within a
 * minute instead of waiting out whatever interval was in effect when the timer last started.
 * Idempotent: calling this while already running just clears and restarts the interval — App.jsx
 * re-calls this on every settings change rather than tracking a "did I already start it" flag
 * itself.
 */
export function startScheduler({ userId, onUpdate, onProgress, onCycleEnd }) {
  stopSchedulerTimer();
  timerId = setInterval(() => tick({ userId, onUpdate, onProgress, onCycleEnd }), TICK_MS);
  // Independent lightweight batch poll — see pollPendingImageBatches. Its own timer so a long full
  // cycle awaited inside tick() can't delay it, and vice versa. Errors are swallowed to a console
  // line: one failed poll must never tear the interval down.
  batchTimerId = setInterval(
    () => pollPendingImageBatches({ userId }).catch((err) => console.error('[automationScheduler] pending-batch poll threw', err)),
    BATCH_POLL_TICK_MS
  );
}

export function stopSchedulerTimer() {
  if (batchTimerId) {
    clearInterval(batchTimerId);
    batchTimerId = null;
  }
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}
