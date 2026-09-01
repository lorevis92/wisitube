import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { listChannels, updateChannelFields, listAutomationLog, getSchedulerSettings, saveSchedulerSettings } from '../lib/db';
import { runAutomationCycle } from '../lib/automationEngine';
import { runManagedCycle, requestStop, applyProgressToRun, forceUnlock } from '../lib/automationScheduler';
import { PROVIDER_LABELS } from '../lib/imageProviders';
import { VOICE_ENGINE_LABELS, MINIMAX_VOICES } from '../lib/voiceProviders';
import { KOKORO_VOICES } from '../lib/tts';
import { STYLES } from '../lib/pollinations';
import ExpandableTextarea from '../components/ExpandableTextarea';
import {
  isLocalExportSupported,
  getStoredLocalExportDirectory,
  pickLocalExportDirectory,
  ensureLocalExportPermission,
} from '../lib/localExport';

const SCHEDULER_POLL_MS = 15000;
const INTERVAL_UNITS = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

// Same fallback CreateStep.jsx uses when switching engines — keeps automation_voice pointing at a
// voice that's actually valid for whichever automation_voice_engine ends up selected.
const DEFAULT_KOKORO_VOICE = 'af_heart';
function defaultVoiceForEngine(engine) {
  return engine === 'minimax' ? MINIMAX_VOICES[0].id : DEFAULT_KOKORO_VOICE;
}

// automationEngine.js's getRecipeForContentType has a real recipe wired up for both:
// 'full_pipeline' (src/lib/recipes/fullPipelineRecipe.js) and 'static_background'
// (src/lib/recipes/staticBackgroundRecipe.js). Also settable from ChannelDashboardStep.jsx (see its
// own copy of this list) since content_type isn't automation-only — it also drives the manual
// Create → Storyboard flow.
const CONTENT_TYPES = [
  { value: 'full_pipeline', label: 'Full Pipeline (images)' },
  { value: 'static_background', label: 'Static Background — Language Learning' },
];

// Same list as CreateStep.jsx's own local LANGUAGES const — duplicated rather than imported since
// CreateStep.jsx doesn't export it (small, stable, controlled-duplication pattern already used
// elsewhere in this codebase, e.g. YOUTUBE_LANGUAGE_CODES in fullPipelineRecipe.js/ExportStep.jsx).
const LANGUAGES = ['English', 'Italiano', 'Español', 'Français', 'Deutsch'];

// Same list as ExportStep.jsx's own local YOUTUBE_CATEGORIES const — duplicated for the same reason.
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

const LOG_POLL_MS = 1500;

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Same buckets as timeAgo, forward-looking — used for the scheduling panel's "Next check" line.
function timeUntil(ts) {
  const sec = Math.floor((ts - Date.now()) / 1000);
  if (sec <= 0) return 'any moment now';
  const min = Math.floor(sec / 60);
  if (min < 1) return `in ${sec}s`;
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `in ${day}d ${hr % 24}h`;
}

// Same mapping as automationScheduler.js's own UNIT_MS — duplicated rather than imported since this
// is only needed here to compute a display estimate ("Next check: ..."), not to drive the actual
// timer, same small-stable-constant duplication already used elsewhere in this codebase (e.g.
// YOUTUBE_LANGUAGE_CODES in ExportStep.jsx/fullPipelineRecipe.js).
const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

// The columns this form's typed number/text fields own (edited locally, saved on blur via
// persistChannel). Everything else here saves immediately via updateAndSaveImmediately with its own
// one-key patch. Neither ever writes the daily counters or topic_scoring_cache — those belong to
// the automation cycle (see db.js's bumpChannelDailyUsage / updateChannelFields).
const BLUR_SAVED_COLUMNS = [
  'automation_videos_per_day',
  'automation_daily_budget_usd',
  'automation_length_minutes',
  'automation_length_cap_min',
  'automation_length_cap_max',
  'automation_directive',
];

function statusColor(status) {
  if (status === 'error') return T.primary;
  if (status === 'dry_run') return T.yellow;
  if (status === 'retrying') return T.yellow;
  // Recovering an abandoned lock (automationScheduler.js's runManagedCycle) — notable, not a
  // failure, but deliberately not the same green as an ordinary successful step either.
  if (status === 'stale_lock_released') return T.yellow;
  // Billing states — a provider's credit ran out mid-run ('credit_exhausted'), or the pre-cycle
  // fal.ai balance check came back low ('low_balance_warning'). Amber, not the red of a generic
  // 'error': the cause is specific and the fix is "top up", not "debug" — and the 💳 in the
  // message itself makes it unmistakable.
  if (status === 'credit_exhausted') return T.yellow;
  if (status === 'low_balance_warning') return T.yellow;
  // The video reached YouTube, but a finishing step (thumbnail / captions / playlist) failed — the
  // upload itself succeeded so it's not a red 'error', but it's not a clean green 'success' either:
  // most often a custom thumbnail that never made it, which needs a manual retry from ExportStep.
  if (status === 'published_with_issues') return T.yellow;
  if (status === 'skipped') return T.textMuted;
  return T.green;
}

export default function AutomationStep({ userId, isMobile, onRunUpdate, onSchedulerEnabledChange }) {
  const [channels, setChannels] = useState(null); // null = still loading
  // Per-channel collapse state, keyed by channel id — closed (falsy/missing) by default so a page
  // with several channels doesn't turn into a wall of near-identical fields (see the header
  // summary line below for what's visible without expanding). Not persisted: every page load starts
  // fully collapsed again, same simple default as everywhere else "closed by default" is used here.
  const [expandedChannels, setExpandedChannels] = useState({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { channelId, channelName, index, total, status }
  const [logItems, setLogItems] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState(''); // '' = all channels
  // shouldStop() is polled synchronously by the engine between channels — a plain state variable
  // would be stale inside that closure, so the kill switch has to be a ref.
  const stopRequestedRef = useRef(false);
  const pollRef = useRef(null);

  // "Automatic scheduling" panel — see src/lib/automationScheduler.js. null while still loading.
  const [schedulerSettings, setSchedulerSettings] = useState(null);
  // Detected via a lightweight, always-on poll (independent of whether THIS component instance
  // started a run) — a real cycle can be in flight because the scheduler's own timer started it
  // while the user was on a completely different tab, and the "Stop" button below still needs to
  // work for that case (see stopCycle), so `running` alone (only true for a run THIS instance
  // started) isn't enough to drive the Run/Stop buttons.
  const [schedulerCycleRunning, setSchedulerCycleRunning] = useState(false);

  // Gemini Batch API isolated test panel (api/gemini-batch.js) — entirely separate from the
  // channels/cycle state above; not read by runAutomationCycle or fullPipelineRecipe.js in any way.
  const [batchPromptsText, setBatchPromptsText] = useState('');
  const [batchItems, setBatchItems] = useState([]); // [{id, prompt}] captured at submit time
  const [batchJobId, setBatchJobId] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchStatus, setBatchStatus] = useState(null); // { state, googleState, stateSource, done, raw }
  const [batchStatusLoading, setBatchStatusLoading] = useState(false);
  const [batchResults, setBatchResults] = useState(null); // [{id, imageBase64, mimeType, error, errorDetail}]
  const [batchResultsLoading, setBatchResultsLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  // Raw status response viewer — collapsed by default, here so a status-mapping mismatch can be
  // diagnosed straight from the browser instead of needing Vercel's server logs.
  const [batchRawOpen, setBatchRawOpen] = useState(false);
  // Same idea for results — unconditional, since the structured grid below is keyed off batchItems
  // (this session's own textarea prompts) and shows nothing useful for a job pasted in via Job ID
  // that was submitted from a different context (e.g. the real automation pipeline, with
  // sceneId:beatIndex keys instead of test-N ones) — the raw response is the only view that always
  // shows something for those.
  const [batchResultsRawOpen, setBatchResultsRawOpen] = useState(false);

  // TEMPORARY diagnostic — calls api/gemini-batch.js with action:'single-test' (a plain non-batch
  // generateContent) with the first prompt, to isolate whether "Request contains an invalid
  // argument" comes from the image request shape itself or from how the batch envelope wraps it.
  // Separate state from the batch flow above so the two never contend for the same status/error display.
  const [singleTestLoading, setSingleTestLoading] = useState(false);
  const [singleTestResult, setSingleTestResult] = useState(null); // { googleStatus, googleOk, sentPayload, googleResponse }
  const [singleTestError, setSingleTestError] = useState('');

  // Local-folder export (channel.automation_export_mode === 'local_folder'). One base folder for the
  // whole app, not per channel — the recipes create a per-channel subfolder inside it.
  const [exportDirName, setExportDirName] = useState(null); // folder name, or null if none chosen
  const [exportDirStatus, setExportDirStatus] = useState('unknown'); // 'granted' | 'prompt' | 'denied' | 'none' | 'unsupported'
  const [exportDirBusy, setExportDirBusy] = useState(false);

  async function refreshExportDirStatus() {
    if (!isLocalExportSupported()) {
      setExportDirStatus('unsupported');
      return;
    }
    const handle = await getStoredLocalExportDirectory();
    if (!handle) {
      setExportDirName(null);
      setExportDirStatus('none');
      return;
    }
    setExportDirName(handle.name || 'chosen folder');
    setExportDirStatus(await ensureLocalExportPermission(handle, { withPrompt: false }));
  }

  async function chooseExportDir() {
    setExportDirBusy(true);
    try {
      const handle = await pickLocalExportDirectory();
      setExportDirName(handle.name || 'chosen folder');
      setExportDirStatus(await ensureLocalExportPermission(handle, { withPrompt: true }));
    } catch (err) {
      if (err?.name !== 'AbortError') window.alert(String(err?.message || err));
    } finally {
      setExportDirBusy(false);
    }
  }

  useEffect(() => {
    refreshExportDirStatus();
  }, []);

  async function loadChannels() {
    const list = await listChannels();
    setChannels(list);
  }

  async function loadLog(filterOverride) {
    setLogLoading(true);
    try {
      const channelId = filterOverride !== undefined ? filterOverride : historyFilter;
      const items = await listAutomationLog({ channelId: channelId || undefined, limit: 100 });
      setLogItems(items);
    } catch (err) {
      console.error('[AutomationStep] failed to load automation log', err);
    } finally {
      setLogLoading(false);
    }
  }

  useEffect(() => {
    loadChannels();
    loadLog('');
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getSchedulerSettings()
      .then(setSchedulerSettings)
      .catch((err) => console.error('[AutomationStep] failed to load scheduler settings', err));
  }, []);

  // Independent of `running` — polls whether ANY real cycle is currently in flight, including one
  // the scheduler started while this component wasn't even mounted, so the Run/Stop buttons below
  // (and the message explaining why Run is disabled) stay accurate regardless of who's driving it.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await getSchedulerSettings();
        if (cancelled) return;
        setSchedulerCycleRunning(s.currentlyRunning);
        // Keeps currentRunStartedAt/lastRunStartedAt fresh too, not just the enabled/interval
        // fields loaded once on mount above — the "cycle currently running" indicator's elapsed-time
        // display and the Force unlock button below both need currentRunStartedAt to stay live while
        // a cycle (or a stuck lock) sits there for a while, and "Next check" needs lastRunStartedAt
        // to stay current even when a cycle was started by the scheduler's own tick (or a manual run
        // from a different tab) rather than this component's own "Run now"/"Run real cycle" click,
        // which refreshes it directly the moment runManagedCycle resolves (see runCycle) — this poll
        // is the fallback for every OTHER trigger path.
        setSchedulerSettings((prev) =>
          prev
            ? { ...prev, currentlyRunning: s.currentlyRunning, currentRunStartedAt: s.currentRunStartedAt, lastRunStartedAt: s.lastRunStartedAt }
            : s
        );
      } catch (err) {
        console.error('[AutomationStep] failed to poll scheduler running state', err);
      }
    }
    poll();
    const id = setInterval(poll, SCHEDULER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Manual escape hatch for a lock that's stuck true with no cycle actually running anywhere (see
  // automationScheduler.js's forceUnlock and its header comment on the residual case this covers) —
  // resets currently_running directly, bypassing runManagedCycle entirely, since the whole point is
  // that no in-memory runManagedCycle call may be left anywhere to release it normally.
  async function forceUnlockScheduler() {
    const ok = window.confirm(
      'Force-unlock the scheduler?\n\nOnly do this if you are certain no cycle is genuinely running right now (in this tab, another tab, or another device) — forcing the lock open while one actually is risks two cycles running concurrently.'
    );
    if (!ok) return;
    try {
      const updated = await forceUnlock();
      setSchedulerSettings(updated);
      setSchedulerCycleRunning(updated.currentlyRunning);
    } catch (err) {
      window.alert(`Force unlock failed: ${String(err.message || err)}`);
    }
  }

  function saveSchedulerPatch(patch) {
    setSchedulerSettings((s) => ({ ...s, ...patch }));
    saveSchedulerSettings(patch)
      .then((updated) => {
        setSchedulerSettings(updated);
        if ('enabled' in patch) onSchedulerEnabledChange?.(updated.enabled);
      })
      .catch((err) => console.error('[AutomationStep] failed to save scheduler settings', err));
  }

  function onHistoryFilterChange(value) {
    setHistoryFilter(value);
    if (!running) loadLog(value);
  }

  function updateLocalField(channelId, patch) {
    setChannels((list) => (list || []).map((c) => (c.id === channelId ? { ...c, ...patch } : c)));
  }

  // Reads the freshest local state (already merged by updateLocalField on every keystroke/change)
  // for exactly the blur-saved columns, and writes ONLY those via a targeted update — so a run of
  // several field edits between saves never overwrites one field with another's stale copy, and a
  // save never reverts a column another code path owns.
  async function persistChannel(channelId) {
    const channel = (channels || []).find((c) => c.id === channelId);
    if (!channel) return;
    const patch = Object.fromEntries(
      BLUR_SAVED_COLUMNS.map((k) => [k, channel[k]]).filter(([, v]) => v !== undefined)
    );
    if (!Object.keys(patch).length) return;
    try {
      const updated = await updateChannelFields(channelId, patch);
      if (updated) setChannels((list) => (list || []).map((c) => (c.id === channelId ? updated : c)));
    } catch (err) {
      console.error('[AutomationStep] failed to save channel automation settings', channelId, err);
    }
  }

  function updateAndSaveImmediately(channelId, patch) {
    updateLocalField(channelId, patch);
    // `patch` keys are already DB column names — write just those, never the whole row.
    updateChannelFields(channelId, patch)
      .then((updated) => {
        if (updated) setChannels((list) => (list || []).map((c) => (c.id === channelId ? updated : c)));
      })
      .catch((err) => {
        // Not swallowed to the console only — a failed setting change (e.g. a column that doesn't
        // exist yet because a DB migration wasn't run) would otherwise leave the UI showing a value
        // that never actually persisted, and the automation cycle silently using the old one.
        console.error('[AutomationStep] failed to save channel automation settings', channelId, err);
        window.alert(
          `Could not save this setting (${Object.keys(patch).join(', ')}): ${String(err?.message || err)}\n\n` +
            'The change on screen has NOT been saved. If this mentions a missing column, the required one-time ' +
            'Supabase migration has not been run yet.'
        );
        // Resync from the DB so the UI stops showing the un-saved value.
        loadChannels();
      });
  }

  function toggleChannelExpanded(channelId) {
    setExpandedChannels((prev) => ({ ...prev, [channelId]: !prev[channelId] }));
  }

  // Turns automationEngine.js's { channelId, channelName, step, message, videoId, project } events
  // into the shape App.jsx's currentAutomationRun / AutomationMirrorStep.jsx expect — delegates to
  // the shared helper (src/lib/automationScheduler.js) so App.jsx's scheduler wiring feeds the exact
  // same mirror shape from its own, separate trigger path. Kept as a functional update (reads prev)
  // so a channel switch mid-cycle resets the rolling log instead of mixing lines from two different
  // channels together.
  function applyProgressToGlobalRun(evt) {
    onRunUpdate?.((prev) => applyProgressToRun(prev, evt));
  }

  async function runCycle(dryRun) {
    console.warn('[run-cycle-debug] runCycle() called', { dryRun, running, channelsLen: channels?.length, schedulerCycleRunning });
    if (running || !channels || channels.length === 0) {
      console.warn('[run-cycle-debug] runCycle() bailing out — running/channels guard', { running, channelsLen: channels?.length });
      return;
    }
    if (!dryRun && schedulerCycleRunning) {
      console.warn('[run-cycle-debug] runCycle() bailing out SILENTLY — schedulerCycleRunning guard fired (no alert, no log row!)', { schedulerCycleRunning });
      return; // Run button below is disabled for this too — belt and suspenders
    }
    console.warn('[run-cycle-debug] runCycle() guards passed, proceeding');
    stopRequestedRef.current = false;
    setRunning(true);
    setProgress(null);
    pollRef.current = setInterval(() => loadLog(historyFilter), LOG_POLL_MS);
    // Only a real cycle goes through the shared lock (runManagedCycle) — dry runs never touch
    // currently_running, so they always "start" trivially and this stays true for them.
    let didStart = true;
    try {
      if (dryRun) {
        await runAutomationCycle({
          userId,
          dryRun: true,
          onUpdate: (p) => setProgress(p),
          onProgress: applyProgressToGlobalRun,
          shouldStop: () => stopRequestedRef.current,
        });
      } else {
        console.warn('[run-cycle-debug] about to call runManagedCycle()');
        const result = await runManagedCycle({
          userId,
          onUpdate: (p) => setProgress(p),
          onProgress: applyProgressToGlobalRun,
        });
        console.warn('[run-cycle-debug] runManagedCycle() returned', result);
        didStart = result.started;
        if (!result.started) window.alert(`Could not start a real cycle right now: ${result.reason}`);
        // The 15s poll effect above only merges currentlyRunning/currentRunStartedAt, not
        // lastRunStartedAt — without this, "Next check" would keep showing a countdown computed
        // from the PREVIOUS run's lastRunStartedAt right after this one just wrote a new one
        // (started successfully) or left it untouched (blocked), instead of reflecting reality
        // immediately.
        try {
          setSchedulerSettings(await getSchedulerSettings());
        } catch (err) {
          console.error('[AutomationStep] failed to refresh scheduler settings after a cycle attempt', err);
        }
      }
    } catch (err) {
      console.warn('[run-cycle-debug] runCycle() caught an exception — SILENTLY, only console.error below, no user-visible feedback', err);
      console.error(`[AutomationStep] ${dryRun ? 'dry-run' : 'real'} cycle failed`, err);
    } finally {
      console.warn('[run-cycle-debug] runCycle() finally block — didStart:', didStart);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setRunning(false);
      loadLog(historyFilter);
      loadChannels(); // pick up automation_daily_upload_count/spend touched by the cycle
      // Only clear the mirror for a run that actually started under THIS click — a blocked attempt
      // (didStart === false) never touched onProgress, so clearing here would wipe out whatever
      // genuinely still-in-progress run (e.g. the scheduler's own) blocked this one in the first place.
      if (didStart) onRunUpdate?.(null);
    }
  }

  function runDryRun() {
    runCycle(true);
  }

  function runRealCycle() {
    const enabled = (channels || []).filter((c) => c.automation_enabled);
    const localFolderChannels = enabled.filter((c) => c.automation_export_mode === 'local_folder');
    const youtubeChannels = enabled.filter((c) => c.automation_export_mode !== 'local_folder');

    let msg = 'This will generate real content';
    if (youtubeChannels.length) msg += ' and publish it to YouTube';
    if (localFolderChannels.length) {
      const names = localFolderChannels.map((c) => c.name || 'a channel').join(', ');
      msg +=
        `. ${localFolderChannels.length} channel${localFolderChannels.length === 1 ? '' : 's'} ` +
        `(${names}) ${localFolderChannels.length === 1 ? 'is' : 'are'} set to LOCAL FOLDER export — ` +
        'those videos are written to your chosen folder, not uploaded. Make sure you\'ve granted folder ' +
        'access this session ("Choose export folder") first';
    }
    msg += '. Continue?';

    const ok = window.confirm(msg);
    if (!ok) return;
    runCycle(false);
  }

  function stopCycle() {
    // Sets both, since either could be the one actually running: stopRequestedRef covers a dry run
    // (dry runs never touch the shared lock/flag below); requestStop() covers a real cycle running
    // under the shared lock, whether the scheduler's own timer or a manual "Run real cycle" click
    // started it — a single "Stop" click always works regardless of which one is in flight.
    stopRequestedRef.current = true;
    requestStop();
  }

  function channelName(id) {
    return (channels || []).find((c) => c.id === id)?.name || id?.slice(0, 8) || '—';
  }

  // One line per prompt → { id, prompt }, ids stable within a submission ("test-1", "test-2"...) so
  // fetchBatchResults can join results back to the textarea line they came from by id.
  function parseBatchPrompts() {
    return batchPromptsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((prompt, i) => ({ id: `test-${i + 1}`, prompt }));
  }

  async function submitTestBatch() {
    const items = parseBatchPrompts();
    if (!items.length) return;
    setBatchError('');
    setBatchSubmitting(true);
    setBatchStatus(null);
    setBatchResults(null);
    setBatchJobId('');
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', items, resolution: '0.5K' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Submit failed');
      setBatchItems(items);
      setBatchJobId(data.jobId);
    } catch (err) {
      setBatchError(String(err.message || err));
    } finally {
      setBatchSubmitting(false);
    }
  }

  // Manual edits to the Job ID field void whatever status/results were showing for whichever job
  // was there before — otherwise pasting a different job id would leave a stale "succeeded" status
  // (and its results grid) on screen for a job that's no longer the one in the field.
  function updateBatchJobId(value) {
    setBatchJobId(value);
    setBatchStatus(null);
    setBatchResults(null);
    setBatchError('');
  }

  async function checkBatchStatus() {
    const jobId = batchJobId.trim();
    if (!jobId) return;
    setBatchError('');
    setBatchStatusLoading(true);
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', jobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Status check failed');
      setBatchStatus(data);
    } catch (err) {
      setBatchError(String(err.message || err));
    } finally {
      setBatchStatusLoading(false);
    }
  }

  async function fetchBatchResults() {
    const jobId = batchJobId.trim();
    if (!jobId) return;
    setBatchError('');
    setBatchResultsLoading(true);
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'results', jobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Fetch results failed');
      setBatchResults(data.results || []);
    } catch (err) {
      setBatchError(String(err.message || err));
    } finally {
      setBatchResultsLoading(false);
    }
  }

  // TEMPORARY diagnostic — see api/gemini-batch.js's action:'single-test' header comment for what
  // this isolates. Uses the first prompt currently in the textarea, whether or not a batch has been
  // submitted yet.
  async function runSingleTest() {
    const items = parseBatchPrompts();
    if (!items.length) return;
    setSingleTestError('');
    setSingleTestLoading(true);
    setSingleTestResult(null);
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'single-test', prompt: items[0].prompt, resolution: '0.5K' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Single test request failed');
      setSingleTestResult(data);
    } catch (err) {
      setSingleTestError(String(err.message || err));
    } finally {
      setSingleTestLoading(false);
    }
  }

  if (channels === null) {
    return <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>Loading your channels…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{ fontFamily: FONT.display, fontSize: 26, color: T.text }}>Automation</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginTop: 6, lineHeight: 1.6, maxWidth: 640 }}>
          Configure per-channel automation below. Dry-run shows exactly what a cycle would do for every enabled channel with no generation,
          spend, or publishing. Real cycle actually does it — generates a real video and publishes it to YouTube for every eligible channel.
          Run it manually below, or turn on unattended background mode so it runs on its own while this tab stays open.
        </div>
      </div>


      <div style={card}>
        <div style={label}>Automatic scheduling</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 8, lineHeight: 1.6, maxWidth: 620 }}>
          Runs a real (non-dry-run) cycle on its own, on the interval below — only while this browser tab stays open, same as every other
          background process in this app. Off by default.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, fontFamily: FONT.ui, color: T.text }}>
          <input
            type="checkbox"
            checked={!!schedulerSettings?.enabled}
            onChange={(e) => saveSchedulerPatch({ enabled: e.target.checked })}
          />
          🔴 Enable unattended background mode
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontFamily: FONT.ui, color: T.text }}>Check every</span>
          <input
            type="number"
            min="1"
            value={schedulerSettings?.intervalValue ?? 6}
            onChange={(e) => saveSchedulerPatch({ intervalValue: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
            style={{ ...inputStyle, width: 80 }}
          />
          <select
            value={schedulerSettings?.intervalUnit || 'hours'}
            onChange={(e) => saveSchedulerPatch({ intervalUnit: e.target.value })}
            style={{ ...inputStyle, width: 140 }}
          >
            {INTERVAL_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 14 }}>
          {schedulerCycleRunning ? (
            <button
              disabled
              title="Another cycle (started by the scheduler or a manual run, in this tab or another) is already using the shared lock"
              style={{ ...btnGhost, opacity: 0.6, cursor: 'default' }}
            >
              ⏳ Cycle already running
            </button>
          ) : (
            <button
              onClick={runRealCycle}
              disabled={running || channels.length === 0}
              style={{ ...btnPrimary, opacity: running || channels.length === 0 ? 0.6 : 1 }}
            >
              ▶ Run now
            </button>
          )}
        </div>

        {schedulerSettings && (
          <div style={{ marginTop: 12, ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Last run: {schedulerSettings.lastRunStartedAt ? timeAgo(schedulerSettings.lastRunStartedAt) : 'never'}</span>
            {schedulerSettings.enabled && (
              <span>
                Next check:{' '}
                {schedulerSettings.lastRunStartedAt
                  ? timeUntil(
                      schedulerSettings.lastRunStartedAt +
                        Math.max(1, Number(schedulerSettings.intervalValue) || 1) * (UNIT_MS[schedulerSettings.intervalUnit] || UNIT_MS.hours)
                    )
                  : 'any moment now'}
              </span>
            )}
            {schedulerCycleRunning && !running && (
              <span style={{ color: T.yellow, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                ⏳ A cycle is currently running in the background
                {schedulerSettings.currentRunStartedAt ? ` — locked ${timeAgo(schedulerSettings.currentRunStartedAt)}` : ''}.
                <button
                  onClick={forceUnlockScheduler}
                  title="Only use this if you're certain no cycle is genuinely running right now — otherwise this risks a concurrent double-run"
                  style={{ ...btnGhost, padding: '4px 10px', fontSize: 10, color: T.primary, borderColor: T.primaryBorder }}
                >
                  🔓 Force unlock
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div style={label}>Channels</div>
          {running || schedulerCycleRunning ? (
            <button onClick={stopCycle} style={{ ...btnGhost, padding: '12px 22px', fontSize: 13, color: T.primary, borderColor: T.primaryBorder }}>
              🛑 Stop
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={runDryRun}
                disabled={channels.length === 0}
                style={{ ...btnGhost, padding: '12px 22px', fontSize: 13, opacity: channels.length === 0 ? 0.6 : 1 }}
              >
                ▶ Run dry-run cycle
              </button>
              <button
                onClick={runRealCycle}
                disabled={channels.length === 0}
                title="Generates real content and publishes to YouTube — real spend, real uploads"
                style={{
                  ...btnPrimary,
                  padding: '12px 22px',
                  fontSize: 13,
                  border: `2px solid ${T.primary}`,
                  boxShadow: `0 0 0 1px ${T.primary}`,
                  opacity: channels.length === 0 ? 0.6 : 1,
                }}
              >
                ▶▶ Run real cycle
              </button>
            </div>
          )}
        </div>

        {running && (
          <div style={{ marginTop: 12, ...mono, fontSize: 12, color: T.textSecondary }}>
            {progress
              ? `Channel ${progress.index + 1}/${progress.total}: ${progress.channelName} — ${progress.status}`
              : 'Starting…'}
          </div>
        )}

        {channels.length === 0 ? (
          <div style={{ marginTop: 14, fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary }}>
            No channels yet — create one from the Channels tab first.
          </div>
        ) : (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {channels.map((c) => {
              const isExpanded = !!expandedChannels[c.id];
              return (
              <div key={c.id} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 14 }}>
                <button
                  onClick={() => toggleChannelExpanded(c.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                    <span
                      title={c.automation_enabled ? 'Enabled' : 'Disabled'}
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: 8,
                        background: c.automation_enabled ? T.green : T.textMuted,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text }}>{c.name}</span>
                    <span style={{ ...mono, fontSize: 11, color: T.textSecondary }}>
                      {PROVIDER_LABELS[c.automation_image_provider] || c.automation_image_provider || 'pollinations'}
                    </span>
                    <span style={{ ...mono, fontSize: 11, color: T.textMuted }}>
                      Today: {c.automation_daily_upload_count || 0}/{c.automation_videos_per_day || 0} uploads · $
                      {(c.automation_daily_spend_usd || 0).toFixed(2)} / ${(c.automation_daily_budget_usd || 0).toFixed(2)} spent
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: T.textMuted,
                      fontFamily: FONT.ui,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      flexShrink: 0,
                    }}
                  >
                    {isExpanded ? 'CLOSE ▲' : 'SHOW ▼'}
                  </span>
                </button>

                {isExpanded && (
                <>
                <div style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <div style={label}>Publishing</div>
                    <select
                      value={c.automation_export_mode || 'youtube'}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_export_mode: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6, maxWidth: 320 }}
                    >
                      <option value="youtube">Upload to YouTube (API)</option>
                      <option value="local_folder">Export to a local folder (upload by hand later)</option>
                    </select>
                  </div>

                  {(c.automation_export_mode || 'youtube') === 'local_folder' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11, fontFamily: FONT.ui, color: T.textSecondary, lineHeight: 1.6 }}>
                        Produced videos are written to <code>{'{folder}/{channel}/{date} - {title}/'}</code> as
                        <code> video.mp4</code>, <code>thumbnail.jpg</code>, <code>publish-info.txt</code> (and
                        <code> captions.srt</code> when subtitles exist). Nothing is uploaded — each video stays
                        "Finished — not published"; use "Mark as published" in the dashboard after uploading it by hand.
                      </div>
                      {exportDirStatus === 'unsupported' ? (
                        <div style={{ ...mono, fontSize: 11, color: T.primary }}>
                          This browser can't do local folder export — use Chrome, Edge or Opera.
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button onClick={chooseExportDir} disabled={exportDirBusy} style={{ ...btnGhost, padding: '6px 12px', fontSize: 11 }}>
                              {exportDirName ? 'Change export folder' : 'Choose export folder'}
                            </button>
                            {exportDirName && (
                              <span style={{ ...mono, fontSize: 11, color: T.textSecondary }}>
                                📁 {exportDirName}
                                {exportDirStatus === 'granted' && <span style={{ color: T.green }}> · access ok</span>}
                                {exportDirStatus === 'prompt' && <span style={{ color: T.yellow }}> · needs re-granting (click "Change export folder")</span>}
                                {exportDirStatus === 'denied' && <span style={{ color: T.primary }}> · access denied</span>}
                              </span>
                            )}
                          </div>
                          {!exportDirName && (
                            <div style={{ ...mono, fontSize: 11, color: T.yellow }}>
                              No folder chosen yet — the automation cycle will fail this channel's publish step until one is set.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        fontFamily: FONT.ui,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: T.textSecondary,
                      }}
                      title="When off, produced videos are rendered and saved but never uploaded to YouTube — review and publish them by hand from Storyboard/Editor/Export."
                    >
                      <input
                        type="checkbox"
                        checked={c.automation_auto_publish !== false}
                        disabled={running}
                        onChange={(e) => updateAndSaveImmediately(c.id, { automation_auto_publish: e.target.checked })}
                      />
                      Auto-publish to YouTube
                    </label>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        fontFamily: FONT.ui,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: T.textSecondary,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!c.automation_enabled}
                        disabled={running}
                        onChange={(e) => updateAndSaveImmediately(c.id, { automation_enabled: e.target.checked })}
                      />
                      Enabled
                    </label>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(170px, 1fr))',
                    gap: 10,
                    marginTop: 12,
                  }}
                >
                  <div>
                    <div style={label}>Content type</div>
                    <select
                      value={c.content_type || ''}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { content_type: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      <option value="">— Select —</option>
                      {CONTENT_TYPES.map((ct) => (
                        <option key={ct.value} value={ct.value}>
                          {ct.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div style={label}>Videos / day</div>
                    <input
                      type="number"
                      min="0"
                      value={c.automation_videos_per_day}
                      disabled={running}
                      onChange={(e) => updateLocalField(c.id, { automation_videos_per_day: Number(e.target.value) })}
                      onBlur={() => persistChannel(c.id)}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </div>

                  <div>
                    <div style={label}>Daily budget ($)</div>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={c.automation_daily_budget_usd}
                      disabled={running}
                      onChange={(e) => updateLocalField(c.id, { automation_daily_budget_usd: Number(e.target.value) })}
                      onBlur={() => persistChannel(c.id)}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </div>

                  <div>
                    <div style={label}>Target length (min)</div>
                    <input
                      type="number"
                      min="1"
                      value={c.automation_length_minutes}
                      disabled={running || c.automation_ai_decides_length}
                      onChange={(e) => updateLocalField(c.id, { automation_length_minutes: Number(e.target.value) })}
                      onBlur={() => persistChannel(c.id)}
                      style={{ ...inputStyle, marginTop: 6, opacity: c.automation_ai_decides_length ? 0.5 : 1 }}
                    />
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 6,
                        fontSize: 11,
                        fontFamily: FONT.ui,
                        color: T.textSecondary,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!c.automation_ai_decides_length}
                        disabled={running}
                        onChange={(e) => updateAndSaveImmediately(c.id, { automation_ai_decides_length: e.target.checked })}
                      />
                      Let AI decide the ideal length
                    </label>
                  </div>

                  {c.automation_ai_decides_length && (
                    <div style={{ gridColumn: '1 / -1', border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                        <input
                          type="checkbox"
                          checked={c.automation_length_cap_enabled ?? true}
                          disabled={running}
                          onChange={(e) => updateAndSaveImmediately(c.id, { automation_length_cap_enabled: e.target.checked })}
                        />
                        Enable safety cap
                      </label>
                      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ ...label, fontSize: 10 }}>Min minutes</div>
                          <input
                            type="number"
                            min="1"
                            value={c.automation_length_cap_min ?? 2}
                            disabled={running || !c.automation_length_cap_enabled}
                            onChange={(e) => updateLocalField(c.id, { automation_length_cap_min: Number(e.target.value) })}
                            onBlur={() => persistChannel(c.id)}
                            style={{ ...inputStyle, marginTop: 4, width: 90, opacity: c.automation_length_cap_enabled ? 1 : 0.5 }}
                          />
                        </div>
                        <div>
                          <div style={{ ...label, fontSize: 10 }}>Max minutes</div>
                          <input
                            type="number"
                            min="1"
                            value={c.automation_length_cap_max ?? 45}
                            disabled={running || !c.automation_length_cap_enabled}
                            onChange={(e) => updateLocalField(c.id, { automation_length_cap_max: Number(e.target.value) })}
                            onBlur={() => persistChannel(c.id)}
                            style={{ ...inputStyle, marginTop: 4, width: 90, opacity: c.automation_length_cap_enabled ? 1 : 0.5 }}
                          />
                        </div>
                      </div>
                      {!c.automation_length_cap_enabled && (
                        <div style={{ fontSize: 10, color: T.yellow, fontFamily: FONT.ui, marginTop: 8 }}>
                          No cap — the AI has full freedom, video length (and cost) could vary widely.
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <div style={label}>Visual style</div>
                    <select
                      value={c.automation_style || 'facestick'}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_style: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {Object.entries(STYLES).map(([id, s]) => (
                        <option key={id} value={id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div style={label}>Image provider</div>
                    <select
                      value={c.automation_image_provider}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_image_provider: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {Object.entries(PROVIDER_LABELS).map(([id, lbl]) => (
                        <option key={id} value={id}>
                          {lbl}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div style={label}>Voice engine</div>
                    <select
                      value={c.automation_voice_engine}
                      disabled={running}
                      onChange={(e) => {
                        const engine = e.target.value;
                        // Switching engines can leave automation_voice pointing at a voice id from
                        // the other engine's list (e.g. a MiniMax voice while now on Kokoro) — reset
                        // it to that engine's default in the same update, same as CreateStep.jsx.
                        updateAndSaveImmediately(c.id, { automation_voice_engine: engine, automation_voice: defaultVoiceForEngine(engine) });
                      }}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {Object.entries(VOICE_ENGINE_LABELS).map(([id, lbl]) => (
                        <option key={id} value={id}>
                          {lbl}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div style={label}>Voice</div>
                    <select
                      value={c.automation_voice || defaultVoiceForEngine(c.automation_voice_engine)}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_voice: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {c.automation_voice_engine === 'minimax'
                        ? MINIMAX_VOICES.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))
                        : Object.entries(KOKORO_VOICES).map(([group, voices]) => (
                            <optgroup key={group} label={group}>
                              {voices.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                    </select>
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <div style={label}>Speech speed</div>
                      <span style={{ ...mono, fontSize: 11, color: T.text, fontWeight: 700 }}>
                        {(Number(c.automation_speech_speed) || 1.0).toFixed(2)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.7"
                      max="1.2"
                      step="0.05"
                      disabled={running}
                      value={Number(c.automation_speech_speed) || 1.0}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_speech_speed: Number(e.target.value) })}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                  </div>

                  <div>
                    <div style={label}>Language</div>
                    <select
                      value={c.automation_language || 'English'}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_language: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div style={label}>Format</div>
                    <select
                      value={c.automation_format || '16:9'}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_format: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      <option value="16:9">16:9 (landscape)</option>
                      <option value="9:16">9:16 (vertical)</option>
                    </select>
                  </div>

                  <div>
                    <div style={label}>YouTube category</div>
                    <select
                      value={c.automation_youtube_category || '27'}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_youtube_category: e.target.value })}
                      style={{ ...inputStyle, marginTop: 6 }}
                    >
                      {YOUTUBE_CATEGORIES.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      fontFamily: FONT.ui,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: T.textSecondary,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!c.automation_made_for_kids}
                      disabled={running}
                      onChange={(e) => updateAndSaveImmediately(c.id, { automation_made_for_kids: e.target.checked })}
                    />
                    Made for kids
                  </label>
                  <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 4, lineHeight: 1.5 }}>
                    Only enable this if the channel is genuinely directed at children — this has real legal implications.
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={label}>Current initiative (optional)</div>
                  <ExpandableTextarea
                    value={c.automation_directive || ''}
                    disabled={running}
                    onChange={(e) => updateLocalField(c.id, { automation_directive: e.target.value })}
                    onBlur={() => persistChannel(c.id)}
                    placeholder="e.g. Make a 5-part series on unusual local customs around the world, one country per video, avoid repeating countries already covered."
                    rows={2}
                    style={{ ...inputStyle, marginTop: 6, resize: 'vertical' }}
                  />
                </div>
                </>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={label}>Automation log</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={historyFilter}
              onChange={(e) => onHistoryFilterChange(e.target.value)}
              style={{ ...inputStyle, width: 'auto', padding: '6px 10px', fontSize: 12 }}
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button onClick={() => loadLog(historyFilter)} disabled={logLoading} style={{ ...btnGhost, padding: '6px 12px', fontSize: 10 }}>
              ↻ Refresh
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: FONT.ui }}>
            <thead>
              <tr style={{ textAlign: 'left', color: T.textMuted, fontSize: 10, textTransform: 'uppercase' }}>
                <th style={{ padding: '6px 8px' }}>Time</th>
                <th style={{ padding: '6px 8px' }}>Channel</th>
                <th style={{ padding: '6px 8px' }}>Step</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Message</th>
              </tr>
            </thead>
            <tbody>
              {logItems.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 14, color: T.textMuted, textAlign: 'center' }}>
                    {logLoading ? 'Loading…' : 'No log entries yet — run a dry-run cycle to see one.'}
                  </td>
                </tr>
              ) : (
                logItems.map((item) => (
                  <tr key={item.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ ...mono, padding: '6px 8px', color: T.textMuted, whiteSpace: 'nowrap' }}>{timeAgo(item.createdAt)}</td>
                    <td style={{ padding: '6px 8px', color: T.text }}>{channelName(item.channelId)}</td>
                    <td style={{ ...mono, padding: '6px 8px', color: T.textSecondary }}>{item.step}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ ...mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: statusColor(item.status) }}>
                        {item.status}
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', color: T.textSecondary }}>{item.message}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Isolated Gemini Batch API test panel (api/gemini-batch.js) — deliberately not wired to
          runAutomationCycle/fullPipelineRecipe.js. Exists only to verify the submit/status/results
          mechanism (id → image mapping, 0.5K quality) by hand before anything depends on it. */}
      <div style={card}>
        <div style={label}>🧪 Gemini Batch API — isolated test panel</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 6, lineHeight: 1.6, maxWidth: 640 }}>
          Submits a small batch of test prompts directly to api/gemini-batch.js — not connected to the automation
          recipe yet. Use this to confirm each result maps back to the right prompt and that 0.5K quality is good
          enough before wiring it into the real pipeline.
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={label}>Test prompts (one per line)</div>
          <textarea
            value={batchPromptsText}
            onChange={(e) => setBatchPromptsText(e.target.value)}
            placeholder={'a red bicycle leaning against a brick wall\na cup of coffee on a wooden table\na cat sleeping on a sunny windowsill'}
            rows={5}
            style={{ ...inputStyle, marginTop: 8, resize: 'vertical' }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={label}>Job ID</div>
          <input
            value={batchJobId}
            onChange={(e) => updateBatchJobId(e.target.value)}
            placeholder="batches/..."
            style={{ ...inputStyle, marginTop: 8 }}
          />
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 4 }}>
            Filled in automatically after a submit — or paste one from a previous session to check/fetch it without
            resubmitting.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            onClick={submitTestBatch}
            disabled={batchSubmitting || !batchPromptsText.trim()}
            style={{ ...btnPrimary, opacity: batchSubmitting || !batchPromptsText.trim() ? 0.6 : 1 }}
          >
            {batchSubmitting ? 'Submitting…' : 'Submit test batch'}
          </button>
          <button
            onClick={checkBatchStatus}
            disabled={!batchJobId.trim() || batchStatusLoading}
            style={{ ...btnGhost, opacity: !batchJobId.trim() ? 0.6 : 1 }}
          >
            {batchStatusLoading ? 'Checking…' : 'Check status'}
          </button>
          {batchStatus?.state === 'succeeded' && (
            <button onClick={fetchBatchResults} disabled={batchResultsLoading} style={{ ...btnGhost, opacity: batchResultsLoading ? 0.6 : 1 }}>
              {batchResultsLoading ? 'Fetching…' : 'Fetch results'}
            </button>
          )}
          <button
            onClick={runSingleTest}
            disabled={singleTestLoading || !batchPromptsText.trim()}
            title="Diagnostic — calls Gemini's plain generateContent directly with the first prompt, bypassing the batch envelope entirely"
            style={{ ...btnGhost, opacity: singleTestLoading || !batchPromptsText.trim() ? 0.6 : 1 }}
          >
            {singleTestLoading ? 'Testing…' : 'Test single (non-batch) request'}
          </button>
        </div>

        {(singleTestResult || singleTestError) && (
          <div style={{ marginTop: 14, padding: 10, border: `1px solid ${T.border}`, borderRadius: 4 }}>
            <div style={{ ...mono, fontSize: 10, color: T.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>
              Single (non-batch) test result
            </div>
            {singleTestError && <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui, marginTop: 8 }}>{singleTestError}</div>}
            {singleTestResult && (
              <>
                <div style={{ ...mono, fontSize: 11, color: singleTestResult.googleOk ? T.green : T.primary, marginTop: 8 }}>
                  {singleTestResult.googleOk ? '✓ Succeeded' : '✗ Failed'} — HTTP {singleTestResult.googleStatus}
                </div>
                <pre
                  style={{
                    marginTop: 8,
                    padding: 8,
                    background: T.surfaceAlt,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    fontSize: 10,
                    lineHeight: 1.5,
                    maxHeight: 260,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {JSON.stringify({ sentPayload: singleTestResult.sentPayload, googleResponse: singleTestResult.googleResponse }, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}

        {batchStatus && (
          <>
            <div style={{ ...mono, fontSize: 11, color: T.textSecondary, marginTop: 4 }}>
              Status: {batchStatus.state}
              {batchStatus.googleState ? ` (${batchStatus.googleState})` : ''}
            </div>
            {batchStatus.stateSource && (
              <div style={{ ...mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>Source: {batchStatus.stateSource}</div>
            )}
            <button
              onClick={() => setBatchRawOpen((v) => !v)}
              style={{ background: 'none', border: 'none', padding: 0, marginTop: 6, fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer' }}
            >
              {batchRawOpen ? 'Hide raw response ▲' : 'Show raw response ▼'}
            </button>
            {batchRawOpen && (
              <pre
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: T.surfaceAlt,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  fontSize: 10,
                  lineHeight: 1.5,
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {JSON.stringify(batchStatus.raw, null, 2)}
              </pre>
            )}
          </>
        )}
        {batchError && <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui, marginTop: 10 }}>{batchError}</div>}

        {batchResults && (
          <>
            {/* Unconditional — the structured grid below is keyed off this session's own
                batchItems, which is empty for a job pasted into Job ID that was submitted
                elsewhere (e.g. the real automation pipeline). This always shows something. */}
            <button
              onClick={() => setBatchResultsRawOpen((v) => !v)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                marginTop: 16,
                fontSize: 10,
                color: T.textMuted,
                fontFamily: FONT.ui,
                fontWeight: 700,
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {batchResultsRawOpen ? 'Hide raw results ▲' : `Show raw results ▼ (${batchResults.length})`}
            </button>
            {batchResultsRawOpen && (
              <pre
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: T.surfaceAlt,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  fontSize: 10,
                  lineHeight: 1.5,
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {JSON.stringify(batchResults, null, 2)}
              </pre>
            )}

            {/* Iterates the results themselves, not batchItems — a result with no matching local
                prompt (this session never submitted it, e.g. a real-pipeline job id pasted into
                Job ID) still renders, labeled with its own raw id/key, instead of being silently
                omitted because nothing in the textarea happened to match it. */}
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {batchResults.map((result) => {
                const item = batchItems.find((it) => it.id === result.id);
                return (
                  <div key={result.id} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}>
                    <div style={{ ...mono, fontSize: 9, color: T.textMuted, marginBottom: 6 }}>{result.id}</div>
                    <div
                      style={{
                        borderRadius: 4,
                        overflow: 'hidden',
                        border: `1px solid ${T.border}`,
                        background: T.surfaceAlt,
                        aspectRatio: '1/1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {result?.imageBase64 ? (
                        <img
                          src={`data:${result.mimeType || 'image/jpeg'};base64,${result.imageBase64}`}
                          alt={item?.prompt || result.id}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textAlign: 'center', padding: 8 }}>
                          {result?.error ? `Error: ${result.error}` : 'No image'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 8, lineHeight: 1.4 }}>
                      {item ? item.prompt : <em style={{ color: T.textMuted }}>(no matching prompt in this session — raw id above)</em>}
                    </div>
                    {result?.errorDetail && (
                      <pre
                        style={{
                          marginTop: 8,
                          padding: 8,
                          background: T.primaryLight,
                          border: `1px solid ${T.primaryBorder}`,
                          borderRadius: 4,
                          fontSize: 10,
                          lineHeight: 1.5,
                          color: T.primary,
                          maxHeight: 200,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {JSON.stringify(result.errorDetail, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
