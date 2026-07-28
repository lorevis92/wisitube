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
import { getSchedulerSettings, saveSchedulerSettings, logAutomationStep, listAutomationLog } from './db';
import { runAutomationCycle } from './automationEngine';

const TICK_MS = 60 * 1000;
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

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
 * another cycle is already in flight — reason is a full, human-readable diagnostic (how long the
 * blocking cycle has been running, and its most recent known log line if one can be found) so
 * whoever reads it — the 'scheduler'/'blocked' log row this function's caller writes, or an alert
 * shown from a blocked manual click — understands immediately why nothing happened, without having
 * to go dig through automation_daily_upload_count or query anything else themselves.
 *
 * Returns { started: true } once runAutomationCycle has finished (successfully, with an error, or
 * stopped) — the lock is always released in a finally, so an uncaught exception can never leave
 * currently_running stuck true forever.
 */
export async function runManagedCycle({ userId, onUpdate, onProgress }) {
  if (claimedLocally) {
    return { started: false, reason: 'another cycle claimed the lock in this same browser tab a moment ago — try again shortly' };
  }

  const settings = await getSchedulerSettings();
  if (settings.currentlyRunning) {
    const startedAt = settings.currentRunStartedAt;
    const elapsed = startedAt ? formatElapsed(Date.now() - startedAt) : 'an unknown amount of time';
    const startedAtText = startedAt ? new Date(startedAt).toLocaleString() : 'an unknown time';
    let lastLineText = 'no recent automation log entry found to diagnose further';
    try {
      const recent = await listAutomationLog({ limit: 1 });
      const l = recent[0];
      if (l) {
        const ago = l.createdAt ? formatElapsed(Date.now() - l.createdAt) : 'an unknown time';
        lastLineText = `last known log line: channel ${l.channelId || '—'}, step "${l.step}" → ${l.status}${l.message ? ` ("${l.message}")` : ''}, ${ago} ago`;
      }
    } catch (err) {
      lastLineText = `could not read the automation log to diagnose further: ${String(err.message || err)}`;
    }
    return {
      started: false,
      reason: `a cycle has been running for ${elapsed} (started ${startedAtText}) — ${lastLineText}`,
    };
  }

  claimedLocally = true;
  stopRequested = false;
  const startedAt = Date.now();
  await saveSchedulerSettings({ currentlyRunning: true, currentRunStartedAt: startedAt, lastRunStartedAt: startedAt });
  try {
    await runAutomationCycle({
      userId,
      dryRun: false,
      onUpdate,
      onProgress,
      shouldStop: () => stopRequested,
    });
    return { started: true };
  } finally {
    claimedLocally = false;
    try {
      await saveSchedulerSettings({ currentlyRunning: false, lastRunFinishedAt: Date.now() });
    } catch (err) {
      console.error('[automationScheduler] failed to release currently_running lock', err);
    }
  }
}

let timerId = null;

async function tick({ userId, onUpdate, onProgress, onCycleEnd }) {
  let settings;
  try {
    settings = await getSchedulerSettings();
  } catch (err) {
    console.error('[automationScheduler] failed to read scheduler settings', err);
    return;
  }
  if (!settings.enabled) return;

  const due = !settings.lastRunStartedAt || Date.now() - settings.lastRunStartedAt >= intervalMs(settings);
  if (!due) return;

  const result = await runManagedCycle({ userId, onUpdate, onProgress });
  if (!result.started) {
    // A global, not per-channel, diagnostic — see db.js's required "alter column channel_id drop
    // not null" note on wisitube_automation_log.
    await logAutomationStep(null, null, 'scheduler', 'blocked', result.reason).catch((err) =>
      console.error('[automationScheduler] failed to log a blocked scheduler tick', err)
    );
  } else {
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
