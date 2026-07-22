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
// display_title, project (jsonb — everything else: titles, scenes, description, tags,
// thumbnails, subtitles, references, characterBible, series… with Blobs stripped).

function fromVideoRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    topic: row.topic || '',
    settings: row.settings || {},
    displayTitle: row.display_title || '',
    ...(row.project || {}),
  };
}

export async function saveVideo(video) {
  const { id, channelId, createdAt, topic, settings, displayTitle, ...project } = video;
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

function fromChannelRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    name: row.name || '',
    niche: row.niche || '',
    editorialNotes: row.editorial_notes || '',
    lastSuggestions: row.last_suggestions || null,
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
    automation_length_minutes: row.automation_length_minutes ?? 5,
    automation_last_reset_date: row.automation_last_reset_date || null,
    automation_daily_upload_count: row.automation_daily_upload_count ?? 0,
    automation_daily_spend_usd: row.automation_daily_spend_usd ?? 0,
    // Defaults to true (opt-out, not opt-in): a channel that's never touched this toggle keeps the
    // pre-existing behavior of publishing every produced video automatically.
    automation_auto_publish: row.automation_auto_publish ?? true,
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
    automation_length_minutes: channel.automation_length_minutes ?? 5,
    automation_last_reset_date: channel.automation_last_reset_date || todayDateString(),
    automation_daily_upload_count: channel.automation_daily_upload_count ?? 0,
    automation_daily_spend_usd: channel.automation_daily_spend_usd ?? 0,
    automation_auto_publish: channel.automation_auto_publish ?? true,
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
