// Phase 2 of the multi-user migration: channels, video project data (structure/text — narration,
// prompts, character bible, outline, beat status) and the cost ledger now live in Supabase
// (Postgres), row-scoped per user via RLS (every table's user_id column defaults to auth.uid()) —
// no explicit user_id filter is added here, the database enforces it. Media Blobs (scene
// images/audio, thumbnails, the rendered video) are NOT persisted by this file: they stay in
// memory/IndexedDB for the current session only, stripped out before every write to wisitube_videos
// (see stripBlobsForSync below). Real Blob persistence is Phase 3.
import { supabase } from './supabase';

export function createId() {
  return crypto.randomUUID();
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Local (not UTC) 'YYYY-MM-DD' — mirrors automationEngine.js's own todayDateString (duplicated
// rather than imported to avoid a circular dependency, since automationEngine.js already imports
// from this file). Used only as saveChannel's JS-side default for automation_last_reset_date, so a
// channel's very first save never has to send an explicit null there.
function todayDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// jsonb can't hold a Blob — deep-copies value, replacing any Blob instance (scene images/audio,
// thumbnails, the rendered video) with null. Everything else (narration, prompts, character bible,
// outline, beat status, and any other plain data) passes through untouched.
export function stripBlobsForSync(value) {
  if (value instanceof Blob) return null;
  if (Array.isArray(value)) return value.map(stripBlobsForSync);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripBlobsForSync(v);
    return out;
  }
  return value;
}

// ---- Videos ----
// wisitube_videos columns: id, channel_id, created_at, updated_at, topic, settings (jsonb),
// display_title, promised_follow_up, promise_fulfilled, project (jsonb — everything else: titles,
// scenes, description, tags, thumbnails, subtitles, references, characterBible, series… with Blobs
// stripped).
//
// promised_follow_up/promise_fulfilled are explicit top-level columns rather than folded into the
// project jsonb blob — api/program-manager.js's pendingPromises query (ChannelDashboardStep.jsx)
// needs to filter/select on these directly (WHERE promised_follow_up IS NOT NULL AND
// promise_fulfilled = false), which a value buried inside jsonb can't do without a much less
// convenient query. Required one-time setup in Supabase (no migration tooling in this repo — run
// manually in the SQL editor once):
//
//   alter table public.wisitube_videos
//     add column if not exists promised_follow_up text,
//     add column if not exists promise_fulfilled boolean not null default false;

function fromVideoRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    topic: row.topic || '',
    settings: row.settings || {},
    displayTitle: row.display_title || '',
    promisedFollowUp: row.promised_follow_up || null,
    promiseFulfilled: !!row.promise_fulfilled,
    ...(row.project || {}),
  };
}

export async function saveVideo(video) {
  const { id, channelId, createdAt, topic, settings, displayTitle, promisedFollowUp, promiseFulfilled, ...project } = video;
  const now = new Date().toISOString();
  const row = {
    id,
    channel_id: channelId,
    created_at: createdAt ? new Date(createdAt).toISOString() : now,
    updated_at: now,
    topic: topic || '',
    // settings.references[].file is a File (a Blob subclass) that's never cleared out of settings
    // after the outline step converts it into project.references — strip it here too, not just
    // project, or every autosave after that point tries to write a File into the jsonb column.
    settings: stripBlobsForSync(settings || {}),
    display_title: displayTitle || '',
    promised_follow_up: promisedFollowUp || null,
    promise_fulfilled: !!promiseFulfilled,
    project: stripBlobsForSync(project),
  };
  const data = unwrap(await supabase.from('wisitube_videos').upsert(row, { onConflict: 'id' }).select().single());
  return fromVideoRow(data);
}

export async function loadVideo(id) {
  const data = unwrap(await supabase.from('wisitube_videos').select('*').eq('id', id).maybeSingle());
  return data ? fromVideoRow(data) : null;
}

export async function listVideosByChannel(channelId) {
  const data = unwrap(
    await supabase.from('wisitube_videos').select('*').eq('channel_id', channelId).order('updated_at', { ascending: false })
  );
  return (data || []).map(fromVideoRow);
}

// Videos on this channel whose closing CTA promised a specific future topic that hasn't been
// addressed by a later video yet — fed to api/program-manager.js as pendingPromises (see
// ChannelDashboardStep.jsx/fullPipelineRecipe.js/staticBackgroundRecipe.js, every call site of that
// endpoint) so the suggestion phase can treat fulfilling them as high priority. Already in the exact
// shape that endpoint expects, so callers don't need their own mapping step.
export async function listPendingPromises(channelId) {
  const data = unwrap(
    await supabase
      .from('wisitube_videos')
      .select('id, display_title, promised_follow_up')
      .eq('channel_id', channelId)
      .eq('promise_fulfilled', false)
      .not('promised_follow_up', 'is', null)
  );
  return (data || []).map((row) => ({ videoId: row.id, videoTitle: row.display_title || '', promise: row.promised_follow_up }));
}

export async function deleteVideo(id) {
  unwrap(await supabase.from('wisitube_videos').delete().eq('id', id));
}

// ---- Channels ----
// wisitube_channels columns: id, created_at, updated_at, name, niche, editorial_notes,
// last_suggestions (jsonb), youtube_connected (bool), youtube_channel_name, youtube_channel_id,
// youtube_refresh_token (flat columns — no nested youtube object, that's not how this table is
// shaped) — the app-level channel object mirrors these same flat, snake_case field names rather
// than reintroducing a nested `youtube` object at this boundary. prompt_overrides (jsonb) follows
// the same flat-field convention — see ChannelDashboardStep.jsx's Prompt Lab: keyed by pipeline
// stage ('titles' | 'outline' | 'scenes' | 'programManager'), each value either a non-empty
// creative-direction string (see src/lib/promptDefaults.js for what it replaces) or absent/empty
// when that stage uses the default.
//
// content_type + automation_* columns configure the automation engine (see
// src/lib/automationEngine.js and AutomationStep.jsx) — also flat, same convention.
// automation_last_reset_date/automation_daily_upload_count/automation_daily_spend_usd are the
// engine's own running state (reset once per day by resetDailyCountersIfNeeded), not something the
// user edits directly, but they live on the same row since they're per-channel like everything else here.
//
// Required one-time setup in Supabase for "Let AI decide the ideal length" (no migration tooling in
// this repo — run manually in the SQL editor once):
//
//   alter table wisitube_channels
//     add column if not exists automation_ai_decides_length boolean not null default false,
//     add column if not exists automation_length_cap_enabled boolean not null default true,
//     add column if not exists automation_length_cap_min integer not null default 2,
//     add column if not exists automation_length_cap_max integer not null default 45;
//
// Required one-time setup for per-suggestion dismiss/replace (Content Program Manager):
//
//   alter table wisitube_channels
//     add column if not exists dismissed_suggestions jsonb not null default '[]'::jsonb;
//
// Required one-time setup for content_type 'static_background' default background/text style:
//
//   alter table wisitube_channels
//     add column if not exists automation_static_bg_color text not null default '#111111',
//     add column if not exists automation_static_bg_image_path text,
//     add column if not exists automation_static_text_color text not null default '#FFFFFF',
//     add column if not exists automation_static_text_outline boolean not null default true,
//     add column if not exists automation_static_text_outline_color text not null default '#000000';
//
// Required one-time setup for configurable narration speed (Kokoro + MiniMax, both content types):
//
//   alter table wisitube_channels
//     add column if not exists automation_speech_speed numeric(3,2) not null default 1.0;
//
// Required one-time setup for the optional channel self-introduction at video start:
//
//   alter table wisitube_channels
//     add column if not exists automation_channel_intro boolean not null default false;

function fromChannelRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    name: row.name || '',
    niche: row.niche || '',
    editorialNotes: row.editorial_notes || '',
    lastSuggestions: row.last_suggestions || null,
    // Titles the channel owner explicitly said "not interested" to (ChannelDashboardStep.jsx) — fed
    // back as avoidTitles on every future Content Program Manager call (a single replacement or a
    // full regeneration) so a dismissed idea doesn't keep resurfacing. Capped at the most recent 50
    // by whoever appends to it, not here.
    dismissed_suggestions: Array.isArray(row.dismissed_suggestions) ? row.dismissed_suggestions : [],
    youtube_connected: !!row.youtube_connected,
    youtube_channel_name: row.youtube_channel_name || '',
    youtube_channel_id: row.youtube_channel_id || '',
    youtube_refresh_token: row.youtube_refresh_token || '',
    prompt_overrides: row.prompt_overrides || {},
    content_type: row.content_type || '',
    automation_enabled: !!row.automation_enabled,
    automation_videos_per_day: row.automation_videos_per_day ?? 1,
    automation_daily_budget_usd: row.automation_daily_budget_usd ?? 0,
    automation_image_provider: row.automation_image_provider || 'pollinations',
    automation_voice_engine: row.automation_voice_engine || 'kokoro',
    // '' (not a fixed voice id) since the right default depends on automation_voice_engine, which
    // this column doesn't know about — callers (AutomationStep.jsx, fullPipelineRecipe.js) fall
    // back to a per-engine default when this is empty, same as content_type's own '' default below.
    automation_voice: row.automation_voice || '',
    automation_speech_speed: row.automation_speech_speed ?? 1.0,
    automation_style: row.automation_style || 'facestick',
    automation_language: row.automation_language || 'English',
    automation_format: row.automation_format || '16:9',
    automation_youtube_category: row.automation_youtube_category || '27',
    automation_made_for_kids: !!row.automation_made_for_kids,
    // '' = no active directive — a channel that's never set one gets ordinary Content Program
    // Manager suggestions (see api/program-manager.js's activeDirective handling).
    automation_directive: row.automation_directive || '',
    automation_length_minutes: row.automation_length_minutes ?? 5,
    // "Let AI decide the ideal length" for this channel's videos (see AutomationStep.jsx and
    // fullPipelineRecipe.js) — when true, automation_length_minutes is ignored entirely.
    automation_ai_decides_length: !!row.automation_ai_decides_length,
    // Optional, removable safety cap on that AI-decided length — only actually applied (passed to
    // api/generate-outline.js) when automation_ai_decides_length is also true AND this is enabled;
    // disabling it means no cap is ever sent, full freedom, exactly as requested. Defaults to
    // enabled (true) and a wide 2-45 minute range: this cap exists specifically to protect a
    // channel's daily budget from an unpredictably long video, so a channel that's never touched
    // these fields gets that protection automatically rather than needing to opt in.
    automation_length_cap_enabled: row.automation_length_cap_enabled ?? true,
    automation_length_cap_min: row.automation_length_cap_min ?? 2,
    automation_length_cap_max: row.automation_length_cap_max ?? 45,
    // Default background/text style for content_type 'static_background' videos on this channel
    // (see ChannelDashboardStep.jsx) — seeded into a new video's own project.staticBackground/
    // staticTextStyle once (StoryboardStep.jsx), then freely overridable per video from there.
    automation_static_bg_color: row.automation_static_bg_color || '#111111',
    automation_static_bg_image_path: row.automation_static_bg_image_path || null,
    automation_static_text_color: row.automation_static_text_color || '#FFFFFF',
    automation_static_text_outline: row.automation_static_text_outline ?? true,
    automation_static_text_outline_color: row.automation_static_text_outline_color || '#000000',
    automation_last_reset_date: row.automation_last_reset_date || null,
    automation_daily_upload_count: row.automation_daily_upload_count ?? 0,
    automation_daily_spend_usd: row.automation_daily_spend_usd ?? 0,
    // Defaults to true (opt-out, not opt-in): a channel that's never touched this toggle keeps the
    // pre-existing behavior of publishing every produced video automatically.
    automation_auto_publish: row.automation_auto_publish ?? true,
    // Opt-in (default off): when true, videos open with a brief welcome introducing the channel's
    // purpose, built from `niche` — see ChannelDashboardStep.jsx and api/generate-outline.js.
    automation_channel_intro: !!row.automation_channel_intro,
  };
}

export async function saveChannel(channel) {
  const now = new Date().toISOString();
  const row = {
    id: channel.id,
    created_at: channel.createdAt ? new Date(channel.createdAt).toISOString() : now,
    updated_at: now,
    name: channel.name || '',
    niche: channel.niche || '',
    editorial_notes: channel.editorialNotes || '',
    last_suggestions: channel.lastSuggestions || null,
    dismissed_suggestions: Array.isArray(channel.dismissed_suggestions) ? channel.dismissed_suggestions : [],
    youtube_connected: !!channel.youtube_connected,
    youtube_channel_name: channel.youtube_channel_name || '',
    youtube_channel_id: channel.youtube_channel_id || '',
    youtube_refresh_token: channel.youtube_refresh_token || '',
    prompt_overrides: channel.prompt_overrides || {},
    // Every automation_* field below gets an explicit JS default mirroring the column's SQL
    // default — a channel that's never touched the Automation tab (e.g. one just created via
    // ChannelsListStep, which only sets id/name/niche/editorialNotes) has none of these fields in
    // memory, and sending an explicit `null` for a NOT NULL column with a default bypasses that
    // default and fails the constraint instead of falling back to it.
    content_type: channel.content_type || '',
    automation_enabled: !!channel.automation_enabled,
    automation_videos_per_day: channel.automation_videos_per_day ?? 1,
    automation_daily_budget_usd: channel.automation_daily_budget_usd ?? 0,
    automation_image_provider: channel.automation_image_provider || 'pollinations',
    automation_voice_engine: channel.automation_voice_engine || 'kokoro',
    automation_voice: channel.automation_voice || '',
    automation_speech_speed: channel.automation_speech_speed ?? 1.0,
    automation_style: channel.automation_style || 'facestick',
    automation_language: channel.automation_language || 'English',
    automation_format: channel.automation_format || '16:9',
    automation_youtube_category: channel.automation_youtube_category || '27',
    automation_made_for_kids: !!channel.automation_made_for_kids,
    automation_directive: channel.automation_directive || '',
    automation_length_minutes: channel.automation_length_minutes ?? 5,
    automation_ai_decides_length: !!channel.automation_ai_decides_length,
    automation_length_cap_enabled: channel.automation_length_cap_enabled ?? true,
    automation_length_cap_min: channel.automation_length_cap_min ?? 2,
    automation_length_cap_max: channel.automation_length_cap_max ?? 45,
    automation_static_bg_color: channel.automation_static_bg_color || '#111111',
    automation_static_bg_image_path: channel.automation_static_bg_image_path || null,
    automation_static_text_color: channel.automation_static_text_color || '#FFFFFF',
    automation_static_text_outline: channel.automation_static_text_outline ?? true,
    automation_static_text_outline_color: channel.automation_static_text_outline_color || '#000000',
    automation_last_reset_date: channel.automation_last_reset_date || todayDateString(),
    automation_daily_upload_count: channel.automation_daily_upload_count ?? 0,
    automation_daily_spend_usd: channel.automation_daily_spend_usd ?? 0,
    automation_auto_publish: channel.automation_auto_publish ?? true,
    automation_channel_intro: !!channel.automation_channel_intro,
  };
  const data = unwrap(await supabase.from('wisitube_channels').upsert(row, { onConflict: 'id' }).select().single());
  return fromChannelRow(data);
}

export async function loadChannel(id) {
  const data = unwrap(await supabase.from('wisitube_channels').select('*').eq('id', id).maybeSingle());
  return data ? fromChannelRow(data) : null;
}

export async function listChannels() {
  const data = unwrap(await supabase.from('wisitube_channels').select('*').order('updated_at', { ascending: false }));
  return (data || []).map(fromChannelRow);
}

export async function deleteChannel(id) {
  const videos = await listVideosByChannel(id);
  await Promise.all(videos.map((v) => deleteVideo(v.id)));
  unwrap(await supabase.from('wisitube_channels').delete().eq('id', id));
}

// ---- YouTube per-channel connection (see api/youtube.js, action=callback, which is the only source of
// this data — there's no server-side storage, so the refresh token round-trips through the OAuth
// redirect's query string and lands here on the client). ----

export async function saveYoutubeConnection(channelId, data) {
  const channel = await loadChannel(channelId);
  if (!channel) return null;
  return saveChannel({
    ...channel,
    youtube_connected: true,
    youtube_channel_name: data.channelName || '',
    youtube_channel_id: data.youtubeChannelId || '',
    youtube_refresh_token: data.refreshToken || '',
  });
}

export async function clearYoutubeConnection(channelId) {
  const channel = await loadChannel(channelId);
  if (!channel) return null;
  return saveChannel({
    ...channel,
    youtube_connected: false,
    youtube_channel_name: '',
    youtube_channel_id: '',
    youtube_refresh_token: '',
  });
}

// ---- Cost ledger — persistent record of real money actually spent (never an estimate), append-
// only: an entry, once written, is never edited or removed, so the numbers here can always be
// trusted as "what really happened" rather than a projection. One entry per successful paid call
// (image via nanobanana/gptimage, audio via MiniMax) — see the recordCost call sites in
// StoryboardStep.jsx and ExportStep.jsx for exactly what counts. ----
// wisitube_cost_ledger columns: id, channel_id, video_id, provider, type, amount_usd, timestamp.

function fromCostRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    videoId: row.video_id,
    provider: row.provider,
    type: row.type, // 'image' | 'audio'
    amountUsd: row.amount_usd,
    timestamp: row.timestamp ? new Date(row.timestamp).getTime() : null,
  };
}

export async function recordCost({ channelId, videoId, provider, type, amountUsd, timestamp }) {
  const row = {
    id: createId(),
    channel_id: channelId,
    video_id: videoId || null,
    provider,
    type,
    amount_usd: amountUsd,
    timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
  };
  const data = unwrap(await supabase.from('wisitube_cost_ledger').insert(row).select().single());
  return fromCostRow(data);
}

export async function getCostsByChannel(channelId) {
  const data = unwrap(
    await supabase.from('wisitube_cost_ledger').select('*').eq('channel_id', channelId).order('timestamp', { ascending: false })
  );
  const items = (data || []).map(fromCostRow);
  const total = items.reduce((sum, e) => sum + (e.amountUsd || 0), 0);
  return { total, items };
}

export async function getTotalCostAllChannels() {
  const data = unwrap(await supabase.from('wisitube_cost_ledger').select('amount_usd'));
  return (data || []).reduce((sum, row) => sum + (row.amount_usd || 0), 0);
}

// ---- Prompt Lab version history — see ChannelDashboardStep.jsx. One row per distinct
// creative-direction edit, per channel per stage ('titles' | 'outline' | 'scenes' |
// 'programManager'), so a channel owner can browse and restore earlier phrasing. Append-only like
// the cost ledger, but deduplicated: savePromptVersion skips the insert when the content is
// identical to the most recent version already on file, so re-saving without changes (e.g. a blur
// with no edits) doesn't pile up identical rows. ----
// wisitube_prompt_versions columns: id, channel_id, stage, content, created_at.

function fromPromptVersionRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    stage: row.stage,
    content: row.content,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

export async function savePromptVersion(channelId, stage, content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return null;
  const existing = unwrap(
    await supabase
      .from('wisitube_prompt_versions')
      .select('content')
      .eq('channel_id', channelId)
      .eq('stage', stage)
      .order('created_at', { ascending: false })
      .limit(1)
  );
  if (existing?.[0]?.content === trimmed) return null; // identical to the latest version — skip
  const row = { id: createId(), channel_id: channelId, stage, content: trimmed, created_at: new Date().toISOString() };
  const data = unwrap(await supabase.from('wisitube_prompt_versions').insert(row).select().single());
  return fromPromptVersionRow(data);
}

export async function listPromptVersions(channelId, stage) {
  const data = unwrap(
    await supabase
      .from('wisitube_prompt_versions')
      .select('*')
      .eq('channel_id', channelId)
      .eq('stage', stage)
      .order('created_at', { ascending: false })
      .limit(20)
  );
  return (data || []).map(fromPromptVersionRow);
}

// ---- Automation engine log — see src/lib/automationEngine.js and AutomationStep.jsx. One row per
// step the engine attempted during a cycle (dry-run today; real generation/upload phases once
// Phase 2 wires them in) — append-only, this is an audit trail, never edited or removed. Powers
// both the live-progress view (polled while a cycle is running) and the history table. ----
// wisitube_automation_log columns: id, channel_id, video_id, step, status, message, created_at.

function fromAutomationLogRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    videoId: row.video_id,
    step: row.step,
    status: row.status, // 'skipped' | 'dry_run' | 'success' | 'error' | …
    message: row.message || '',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

export async function logAutomationStep(channelId, videoId, step, status, message) {
  const row = {
    id: createId(),
    channel_id: channelId,
    video_id: videoId || null,
    step,
    status,
    message: message || '',
    created_at: new Date().toISOString(),
  };
  const data = unwrap(await supabase.from('wisitube_automation_log').insert(row).select().single());
  return fromAutomationLogRow(data);
}

export async function listAutomationLog({ channelId, limit = 50 } = {}) {
  let query = supabase.from('wisitube_automation_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (channelId) query = query.eq('channel_id', channelId);
  const data = unwrap(await query);
  return (data || []).map(fromAutomationLogRow);
}

// ---- Unattended scheduler settings — see src/lib/automationScheduler.js and AutomationStep.jsx's
// "Automatic scheduling" panel. One row per user (user_id is the primary key itself, defaulting to
// auth.uid() — there's nothing to key on except the user, unlike channels/videos which have their
// own client-generated id), holding whether the background heartbeat is enabled, how often it
// should check, and the currently_running/current_run_started_at lock the scheduler and a manual
// "Run real cycle" click share so the two can never run a cycle concurrently (see
// automationScheduler.js's runManagedCycle). ----
// wisitube_scheduler_settings columns: user_id, enabled, interval_value, interval_unit
// ('minutes'|'hours'|'days'), last_run_started_at, last_run_finished_at, currently_running,
// current_run_started_at, updated_at.
//
// Required one-time setup in Supabase (no migration tooling in this repo — run manually in the SQL
// editor once):
//
//   create table if not exists wisitube_scheduler_settings (
//     user_id uuid primary key references auth.users(id) default auth.uid(),
//     enabled boolean not null default false,
//     interval_value integer not null default 6,
//     interval_unit text not null default 'hours' check (interval_unit in ('minutes', 'hours', 'days')),
//     last_run_started_at timestamptz,
//     last_run_finished_at timestamptz,
//     currently_running boolean not null default false,
//     current_run_started_at timestamptz,
//     updated_at timestamptz not null default now()
//   );
//   alter table wisitube_scheduler_settings enable row level security;
//   create policy "scheduler settings are per-user" on wisitube_scheduler_settings
//     for all using (user_id = auth.uid()) with check (user_id = auth.uid());
//   -- The scheduler's "blocked" diagnostic (see automationScheduler.js) is a global event, not tied
//   -- to any one channel, so wisitube_automation_log.channel_id must accept null:
//   alter table wisitube_automation_log alter column channel_id drop not null;

const SCHEDULER_DEFAULTS = {
  enabled: false,
  intervalValue: 6,
  intervalUnit: 'hours',
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  currentlyRunning: false,
  currentRunStartedAt: null,
};

function fromSchedulerRow(row) {
  if (!row) return null;
  return {
    enabled: !!row.enabled,
    intervalValue: row.interval_value ?? SCHEDULER_DEFAULTS.intervalValue,
    intervalUnit: row.interval_unit || SCHEDULER_DEFAULTS.intervalUnit,
    lastRunStartedAt: row.last_run_started_at ? new Date(row.last_run_started_at).getTime() : null,
    lastRunFinishedAt: row.last_run_finished_at ? new Date(row.last_run_finished_at).getTime() : null,
    currentlyRunning: !!row.currently_running,
    currentRunStartedAt: row.current_run_started_at ? new Date(row.current_run_started_at).getTime() : null,
  };
}

// No row yet (a user who's never touched the scheduling panel or run a real cycle) resolves to the
// same defaults the SQL columns themselves default to — never null, so every caller can read
// settings.enabled/intervalValue/etc. unconditionally.
export async function getSchedulerSettings() {
  const data = unwrap(await supabase.from('wisitube_scheduler_settings').select('*').maybeSingle());
  return fromSchedulerRow(data) || { ...SCHEDULER_DEFAULTS };
}

// Genuinely partial — only the keys present in `patch` are written (and thus only those are
// touched by the upsert's ON CONFLICT DO UPDATE), so e.g. runManagedCycle setting just
// { currentlyRunning: true, currentRunStartedAt } can never clobber the user's enabled/interval
// choice, and the settings panel saving { enabled } can never stomp the running-lock fields.
// user_id is deliberately never part of the row sent here — same convention as every other table in
// this file ("no explicit user_id filter is added here, the database enforces it"): the column's
// own default (auth.uid()) populates it on first insert, and that same generated value is what the
// upsert's ON CONFLICT (user_id) target matches against on every later call, so this never needs to
// read the current user's id at all.
export async function saveSchedulerSettings(patch) {
  // Same race mediaStorage.js's uploadMedia already had to close for Storage inserts: neither
  // saveChannel nor saveVideo send an explicit user_id either (both rely on the column's own
  // `default auth.uid()`, same as this table), so that alone isn't what's different here. What IS
  // different is WHEN this call tends to fire — this is very often the very first WRITE-type
  // Supabase call of a session (clicking "Run real cycle" moments after opening the tab, or the
  // scheduler's own background tick), whereas saveChannel/saveVideo are almost always preceded by
  // several other successful requests that have already forced the client's session to finish
  // hydrating/refreshing. A SELECT (getSchedulerSettings, listChannels, …) racing the same window
  // just silently returns an empty/default result under RLS — an upsert instead gets a hard 403
  // ("new row violates row-level security policy"), because auth.uid() resolves to null server-side
  // and the WITH CHECK (user_id = auth.uid()) policy rejects the row outright. Explicitly awaiting
  // getSession() here, right before the request, guarantees the session is attached before it goes out.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('No authenticated Supabase session — cannot save scheduler settings (the request would be rejected by RLS as anonymous).');
  }

  const row = { updated_at: new Date().toISOString() };
  if ('enabled' in patch) row.enabled = !!patch.enabled;
  if ('intervalValue' in patch) row.interval_value = patch.intervalValue;
  if ('intervalUnit' in patch) row.interval_unit = patch.intervalUnit;
  if ('lastRunStartedAt' in patch) row.last_run_started_at = patch.lastRunStartedAt ? new Date(patch.lastRunStartedAt).toISOString() : null;
  if ('lastRunFinishedAt' in patch) row.last_run_finished_at = patch.lastRunFinishedAt ? new Date(patch.lastRunFinishedAt).toISOString() : null;
  if ('currentlyRunning' in patch) row.currently_running = !!patch.currentlyRunning;
  if ('currentRunStartedAt' in patch)
    row.current_run_started_at = patch.currentRunStartedAt ? new Date(patch.currentRunStartedAt).toISOString() : null;
  const data = unwrap(await supabase.from('wisitube_scheduler_settings').upsert(row, { onConflict: 'user_id' }).select().single());
  return fromSchedulerRow(data);
}
