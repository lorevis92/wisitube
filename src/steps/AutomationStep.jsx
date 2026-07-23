import React, { useEffect, useRef, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import { listChannels, saveChannel, listAutomationLog } from '../lib/db';
import { runAutomationCycle } from '../lib/automationEngine';
import { PROVIDER_LABELS } from '../lib/imageProviders';
import { VOICE_ENGINE_LABELS, MINIMAX_VOICES } from '../lib/voiceProviders';
import { KOKORO_VOICES } from '../lib/tts';
import { STYLES } from '../lib/pollinations';

// Same fallback CreateStep.jsx uses when switching engines — keeps automation_voice pointing at a
// voice that's actually valid for whichever automation_voice_engine ends up selected.
const DEFAULT_KOKORO_VOICE = 'af_heart';
function defaultVoiceForEngine(engine) {
  return engine === 'minimax' ? MINIMAX_VOICES[0].id : DEFAULT_KOKORO_VOICE;
}

// Phase 1 only ships one real recipe (see automationEngine.js getRecipeForContentType) — no other
// content types are invented here ahead of that.
const CONTENT_TYPES = [{ value: 'full_pipeline', label: 'Full Pipeline (images)' }];

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

function statusColor(status) {
  if (status === 'error') return T.primary;
  if (status === 'dry_run') return T.yellow;
  if (status === 'retrying') return T.yellow;
  if (status === 'skipped') return T.textMuted;
  return T.green;
}

export default function AutomationStep({ userId, isMobile, onRunUpdate }) {
  const [channels, setChannels] = useState(null); // null = still loading
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { channelId, channelName, index, total, status }
  const [logItems, setLogItems] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState(''); // '' = all channels
  // shouldStop() is polled synchronously by the engine between channels — a plain state variable
  // would be stale inside that closure, so the kill switch has to be a ref.
  const stopRequestedRef = useRef(false);
  const pollRef = useRef(null);

  // Gemini Batch API isolated test panel (api/gemini-batch.js) — entirely separate from the
  // channels/cycle state above; not read by runAutomationCycle or fullPipelineRecipe.js in any way.
  const [batchPromptsText, setBatchPromptsText] = useState('');
  const [batchItems, setBatchItems] = useState([]); // [{id, prompt}] captured at submit time
  const [batchJobId, setBatchJobId] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchStatus, setBatchStatus] = useState(null); // { state, googleState, stateSource, done, raw }
  const [batchStatusLoading, setBatchStatusLoading] = useState(false);
  const [batchResults, setBatchResults] = useState(null); // [{id, imageBase64, mimeType, error}]
  const [batchResultsLoading, setBatchResultsLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  // Raw status response viewer — collapsed by default, here so a status-mapping mismatch can be
  // diagnosed straight from the browser instead of needing Vercel's server logs.
  const [batchRawOpen, setBatchRawOpen] = useState(false);

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

  function onHistoryFilterChange(value) {
    setHistoryFilter(value);
    if (!running) loadLog(value);
  }

  function updateLocalField(channelId, patch) {
    setChannels((list) => (list || []).map((c) => (c.id === channelId ? { ...c, ...patch } : c)));
  }

  // Reads the freshest local state (already merged by updateLocalField on every keystroke/change)
  // rather than taking the patch directly, so a run of several field edits between saves — or a
  // save triggered by a sibling field's onChange — never overwrites one field with another's stale copy.
  async function persistChannel(channelId) {
    const channel = (channels || []).find((c) => c.id === channelId);
    if (!channel) return;
    try {
      const updated = await saveChannel(channel);
      setChannels((list) => (list || []).map((c) => (c.id === channelId ? updated : c)));
    } catch (err) {
      console.error('[AutomationStep] failed to save channel automation settings', channelId, err);
    }
  }

  function updateAndSaveImmediately(channelId, patch) {
    updateLocalField(channelId, patch);
    const channel = (channels || []).find((c) => c.id === channelId);
    if (!channel) return;
    saveChannel({ ...channel, ...patch })
      .then((updated) => setChannels((list) => (list || []).map((c) => (c.id === channelId ? updated : c))))
      .catch((err) => console.error('[AutomationStep] failed to save channel automation settings', channelId, err));
  }

  // Turns automationEngine.js's { channelId, channelName, step, message, videoId, project } events
  // into the shape App.jsx's currentAutomationRun / AutomationMirrorStep.jsx expect — kept as a
  // functional update (reads prev) so a channel switch mid-cycle resets the rolling log instead of
  // mixing lines from two different channels together.
  function applyProgressToGlobalRun(evt) {
    onRunUpdate?.((prev) => {
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
    });
  }

  async function runCycle(dryRun) {
    if (running || !channels || channels.length === 0) return;
    stopRequestedRef.current = false;
    setRunning(true);
    setProgress(null);
    pollRef.current = setInterval(() => loadLog(historyFilter), LOG_POLL_MS);
    try {
      await runAutomationCycle({
        userId,
        dryRun,
        onUpdate: (p) => setProgress(p),
        onProgress: applyProgressToGlobalRun,
        shouldStop: () => stopRequestedRef.current,
      });
    } catch (err) {
      console.error(`[AutomationStep] ${dryRun ? 'dry-run' : 'real'} cycle failed`, err);
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setRunning(false);
      loadLog(historyFilter);
      loadChannels(); // pick up automation_daily_upload_count/spend touched by the cycle
      onRunUpdate?.(null); // the whole cycle ended (or was stopped) — no run left to mirror
    }
  }

  function runDryRun() {
    runCycle(true);
  }

  function runRealCycle() {
    const ok = window.confirm('This will generate real content and publish to YouTube. Continue?');
    if (!ok) return;
    runCycle(false);
  }

  function stopCycle() {
    stopRequestedRef.current = true;
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

  async function checkBatchStatus() {
    if (!batchJobId) return;
    setBatchError('');
    setBatchStatusLoading(true);
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', jobId: batchJobId }),
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
    if (!batchJobId) return;
    setBatchError('');
    setBatchResultsLoading(true);
    try {
      const res = await fetch('/api/gemini-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'results', jobId: batchJobId }),
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
          Both are started manually here; nothing runs on its own yet.
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div style={label}>Channels</div>
          {running ? (
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
            {channels.map((c) => (
              <div key={c.id} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text }}>{c.name}</div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
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
                      disabled={running}
                      onChange={(e) => updateLocalField(c.id, { automation_length_minutes: Number(e.target.value) })}
                      onBlur={() => persistChannel(c.id)}
                      style={{ ...inputStyle, marginTop: 6 }}
                    />
                  </div>

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
                  <textarea
                    value={c.automation_directive || ''}
                    disabled={running}
                    onChange={(e) => updateLocalField(c.id, { automation_directive: e.target.value })}
                    onBlur={() => persistChannel(c.id)}
                    placeholder="e.g. Make a 5-part series on unusual local customs around the world, one country per video, avoid repeating countries already covered."
                    rows={2}
                    style={{ ...inputStyle, marginTop: 6, resize: 'vertical' }}
                  />
                </div>

                <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 10 }}>
                  Today: {c.automation_daily_upload_count || 0}/{c.automation_videos_per_day || 0} uploads · $
                  {(c.automation_daily_spend_usd || 0).toFixed(2)} / ${(c.automation_daily_budget_usd || 0).toFixed(2)} spent
                </div>
              </div>
            ))}
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
            disabled={!batchJobId || batchStatusLoading}
            style={{ ...btnGhost, opacity: !batchJobId ? 0.6 : 1 }}
          >
            {batchStatusLoading ? 'Checking…' : 'Check status'}
          </button>
          {batchStatus?.state === 'succeeded' && (
            <button onClick={fetchBatchResults} disabled={batchResultsLoading} style={{ ...btnGhost, opacity: batchResultsLoading ? 0.6 : 1 }}>
              {batchResultsLoading ? 'Fetching…' : 'Fetch results'}
            </button>
          )}
        </div>

        {batchJobId && <div style={{ ...mono, fontSize: 11, color: T.textSecondary, marginTop: 10 }}>Job: {batchJobId}</div>}
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
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {batchItems.map((item) => {
              const result = batchResults.find((r) => r.id === item.id);
              return (
                <div key={item.id} style={{ border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}>
                  <div style={{ ...mono, fontSize: 9, color: T.textMuted, marginBottom: 6 }}>{item.id}</div>
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
                        alt={item.prompt}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <span style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, textAlign: 'center', padding: 8 }}>
                        {result?.error ? `Error: ${result.error}` : 'No image'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 8, lineHeight: 1.4 }}>{item.prompt}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
