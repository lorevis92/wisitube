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
import { getSchedulerSettings, saveSchedulerSettings, logAutomationStep, getLastRealAutomationLogEntry } from './db';
import { runAutomationCycle } from './automationEngine';

const TICK_MS = 60 * 1000;
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

// A cycle stuck this long is presumed dead, not still legitimately working — see runManagedCycle's
// stale-lock recovery below. Well above how long a real cycle should ever sit on one channel (even
// the slowest Gemini Batch jobs rarely run past a couple hours, and a healthy cycle moves on to the
// next channel rather than blocking on one), so this only ever fires for a genuinely abandoned lock.
const STALE_LOCK_MS = 4 * 60 * 60 * 1000;
const STALE_LOCK_HOURS = STALE_LOCK_MS / (60 * 60 * 1000);

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
 * When the blocking cycle has been running longer than STALE_LOCK_HOURS, the lock is instead
 * presumed abandoned — most likely the tab/computer that held it went away (closed, slept, crashed,
 * lost network) mid-cycle, before the finally below that normally releases it ever got to run —
 * auto-released (logged as 'stale_lock_released', never as an ordinary success), and this same call
 * falls through to acquire the lock fresh and actually run, rather than waiting for a later tick to
 * separately notice the lock is free.
 *
 * Returns { started: true } once runAutomationCycle has finished (successfully, with an error, an
 * inProgress:true "still waiting on Gemini Batch" result, or stopped) — the lock is always released
 * in a finally, so an uncaught exception can never leave currently_running stuck true forever. The
 * remaining gap this can't close is the tab going away entirely (see the stale-lock recovery
 * above), not an exception — nothing throws in that case, there's nothing for a finally to catch.
 */
export async function runManagedCycle({ userId, onUpdate, onProgress }) {
  console.warn('[run-cycle-debug] runManagedCycle() entered, claimedLocally =', claimedLocally);
  if (claimedLocally) {
    console.warn('[run-cycle-debug] runManagedCycle() bailing out — claimedLocally is already true in this tab');
    return { started: false, reason: 'another cycle claimed the lock in this same browser tab a moment ago — try again shortly' };
  }

  console.warn('[run-cycle-debug] runManagedCycle() about to call getSchedulerSettings()');
  const settings = await getSchedulerSettings();
  console.warn('[run-cycle-debug] getSchedulerSettings() returned', settings);
  if (settings.currentlyRunning) {
    console.warn('[run-cycle-debug] runManagedCycle() bailing out — DB says currently_running is already true', {
      currentRunStartedAt: settings.currentRunStartedAt,
      elapsedMs: settings.currentRunStartedAt ? Date.now() - settings.currentRunStartedAt : null,
    });
    const startedAt = settings.currentRunStartedAt;
    const elapsedMs = startedAt ? Date.now() - startedAt : null;
    const elapsed = startedAt ? formatElapsed(elapsedMs) : 'an unknown amount of time';
    const startedAtText = startedAt ? new Date(startedAt).toLocaleString() : 'an unknown time';
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

    // A lock only ever known to be this old is presumed abandoned (see STALE_LOCK_MS above), not
    // still legitimately in progress — auto-release it and fall through to the ordinary
    // acquire-and-run path below instead of returning blocked, so this same tick recovers
    // immediately rather than leaving the scheduler sitting idle until someone notices and clicks
    // "Force unlock" (potentially days, exactly what actually happened here once already).
    if (elapsedMs !== null && elapsedMs > STALE_LOCK_MS) {
      const staleMessage = `stale lock auto-released after ${elapsed} (started ${startedAtText}, past the ${STALE_LOCK_HOURS}h threshold) — ${lastLineText}`;
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
        reason: `a cycle has been running for ${elapsed} (started ${startedAtText}) — ${lastLineText}`,
      };
    }
  }

  // BUG FIX: claimedLocally = true and the initial "acquire the lock" write used to sit BEFORE this
  // try/finally. If that write itself threw (a network drop, an expired session, anything) the
  // exception propagated straight out of runManagedCycle — claimedLocally was left stuck true for
  // the rest of this tab's lifetime (every later call, from the scheduler's own tick or a manual
  // "Run real cycle" click, would immediately hit the branch above and return its hardcoded "a
  // moment ago" message forever, regardless of how much real time had actually passed — that's
  // exactly the stale-message symptom this fix addresses), and if the write had actually landed
  // server-side despite the client-side failure (an ambiguous "committed but response lost" case),
  // currently_running was left stuck true in the database too, since runAutomationCycle — and the
  // finally that releases the DB lock — was never even reached. Wrapping the acquire itself in this
  // try/finally guarantees claimedLocally always gets released, whatever fails.
  console.warn('[run-cycle-debug] runManagedCycle() acquiring lock — claimedLocally = true');
  claimedLocally = true;
  try {
    stopRequested = false;
    const startedAt = Date.now();
    console.warn('[run-cycle-debug] runManagedCycle() about to write currently_running=true to DB');
    await saveSchedulerSettings({ currentlyRunning: true, currentRunStartedAt: startedAt, lastRunStartedAt: startedAt });
    console.warn('[run-cycle-debug] runManagedCycle() wrote currently_running=true, about to call runAutomationCycle()');
    try {
      await runAutomationCycle({
        userId,
        dryRun: false,
        onUpdate,
        onProgress,
        shouldStop: () => stopRequested,
      });
      console.warn('[run-cycle-debug] runManagedCycle() runAutomationCycle() resolved normally');
      return { started: true };
    } finally {
      // Runs whether runAutomationCycle resolved normally (success, a per-channel error already
      // caught internally, or a video left inProgress:true awaiting Gemini Batch — none of these are
      // exceptions, they're all just different normal return paths) or, in the unlikely case
      // something above it truly threw, on that exception too — inProgress:true never bypasses this.
      try {
        console.warn('[run-cycle-debug] runManagedCycle() finally — releasing DB lock (currently_running=false)');
        await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
        console.warn('[run-cycle-debug] runManagedCycle() DB lock released');
      } catch (err) {
        console.warn('[run-cycle-debug] runManagedCycle() FAILED to release DB lock — see error below', err);
        console.error('[automationScheduler] failed to release currently_running lock', err);
      }
    }
  } finally {
    console.warn('[run-cycle-debug] runManagedCycle() outer finally — claimedLocally = false');
    claimedLocally = false;
  }
}

// Manual escape hatch for a lock that's genuinely stuck (see AutomationStep.jsx's "Force unlock"
// button) — for a lock under STALE_LOCK_HOURS old that's stuck for a reason the automatic
// recovery above doesn't cover yet, or simply when someone doesn't want to wait out the threshold
// (e.g. the acquire write's response was lost after it had already committed server-side, leaving
// currently_running=true with no in-memory runManagedCycle call left anywhere to release it,
// including in another tab/session entirely, which this module's own claimedLocally guard can't see
// at all). Resets the DB lock only — never touches claimedLocally, which is scoped to whichever tab
// actually holds it, if any.
export async function forceUnlock() {
  await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
}

let timerId = null;

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
}

export function stopSchedulerTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}
