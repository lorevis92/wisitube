import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import {
  listVideosByChannel,
  saveVideo,
  loadVideo,
  updateVideoFields,
  loadChannel,
  listChannels,
  updateChannelFields,
  deleteChannel,
  clearYoutubeConnection,
  getCostsByChannel,
  savePromptVersion,
  listPromptVersions,
  recordCost,
} from '../lib/db';
import { getMediaUrl, uploadMedia } from '../lib/mediaStorage';
import { deleteVideoAndMedia } from '../lib/mediaArchival';
import { createShortRecord } from '../lib/shortsEngine';
import { runFullPipeline } from '../lib/recipes/fullPipelineRecipe';
import { runManagedResume } from '../lib/automationScheduler';
import { logStep } from '../lib/automationEngine';
import { listChannelPlaylists } from '../lib/youtubePublishEngine';
import { getTopicSuggestions, startTopicSuggestion, dismissTopicSuggestion } from '../lib/contentProgramManager';
import ProgramManagerChat from '../components/ProgramManagerChat';
import { DEFAULT_CREATIVE_DIRECTION, SCHEMA_INSTRUCTIONS_DISPLAY } from '../lib/promptDefaults';
import { generateImage } from '../lib/sceneOrchestrator';
import { priceForImage } from '../lib/imageProviders';
import ExpandableTextarea from '../components/ExpandableTextarea';

// A channel-level default asset isn't tied to any one video, but uploadMedia (src/lib/mediaStorage.js)
// is keyed by (userId, videoId, kind, id) — reusing it here with a stable per-channel pseudo-videoId
// avoids adding a whole separate storage mechanism just for one default image per channel.
function channelDefaultsPseudoVideoId(channelId) {
  return `channel-defaults-${channelId}`;
}

// Same list as AutomationStep.jsx's own local CONTENT_TYPES const — duplicated rather than shared,
// same controlled-duplication convention as elsewhere in this codebase. content_type isn't purely an
// automation setting: it also drives the manual Create → Storyboard flow's script generation and
// gates this page's "Default video settings" card below, so it needs to be settable here too, not
// only from the Automation tab.
const CONTENT_TYPES = [
  { value: 'full_pipeline', label: 'Full Pipeline (images)' },
  { value: 'static_background', label: 'Static Background — Language Learning' },
];

const PROMPT_STAGES = [
  { key: 'titles', stageLabel: 'Titles & Angles' },
  { key: 'outline', stageLabel: 'Outline & Structure' },
  { key: 'scenes', stageLabel: 'Scene Writing' },
  { key: 'programManager', stageLabel: 'Content Program Manager' },
];

// Full, absolute date+time — same convention as AutomationMirrorStep.jsx's "Videos in progress" /
// "Recently completed" lists. Used for the video-card timestamp so it stays a fixed reference that
// never shifts when a video is merely opened (which bumps updated_at via autosave).
function formatDateTime(ts) {
  return ts ? new Date(ts).toLocaleString() : 'unknown time';
}

// The video grid is ordered by creation time, newest first — deliberately NOT updated_at: opening a
// video (even just to view it) triggers App.jsx's debounced autosave, which rewrites updated_at, so
// ordering by it would reshuffle the grid every time a card is clicked. created_at is immutable.
function sortVideosForGrid(list) {
  return [...(list || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`;
  const year = Math.floor(month / 12);
  return `${year} year${year === 1 ? '' : 's'} ago`;
}

function priorityColor(p) {
  if (p === 'high') return T.primary;
  if (p === 'medium') return T.yellow;
  return T.textMuted;
}

// Accepts a bare YouTube video id, a full youtube.com/watch?v=... URL, a youtu.be/... short link,
// or a youtube.com/shorts/... URL, and returns just the id — used by the "Edit YouTube status"
// popover so pasting the address bar URL works exactly like pasting the id itself. Falls back to
// returning the trimmed input unchanged when none of the URL shapes match, on the assumption it's
// already a bare id (rather than rejecting it outright).
function extractYoutubeId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const patterns = [/youtu\.be\/([\w-]{6,})/, /[?&]v=([\w-]{6,})/, /youtube\.com\/shorts\/([\w-]{6,})/];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return trimmed;
}

export default function ChannelDashboardStep({ channelId, userId, onResume, onNewVideo, onBack, onChannelChange, onStartVideoFromSuggestion, isMobile, onRunProgress, onRunEnd }) {
  const [channel, setChannel] = useState(null);
  const [name, setName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [niche, setNiche] = useState('');
  const [notes, setNotes] = useState('');
  const [videos, setVideos] = useState(null); // null = still loading
  const [thumbUrls, setThumbUrls] = useState({});
  // Parent video id whose companion Short is being generated right now via the manual "Generate
  // Short" button (bridges the moment between click and the first refetch that shows the new record).
  const [generatingShortFor, setGeneratingShortFor] = useState(null);
  const [shortPublishChoiceFor, setShortPublishChoiceFor] = useState(null); // parent videoId showing the publish-mode picker
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [refiningIndex, setRefiningIndex] = useState(null);
  const [refineText, setRefineText] = useState('');
  // True while a background single-suggestion replacement (see startSuggestion below) is in
  // flight — shown as a small loading placeholder card at the end of the suggestions grid so the
  // list doesn't visibly shrink by one and then jump back once the replacement arrives.
  const [awaitingReplacement, setAwaitingReplacement] = useState(false);
  const [totalSpent, setTotalSpent] = useState(0);
  const [showPromptLab, setShowPromptLab] = useState(false);
  // Section collapse state — same "SHOW ▼/CLOSE ▲" pattern as Prompt Lab (and AutomationStep.jsx's
  // per-channel sections), not persisted across sessions: every page load starts from these
  // defaults again. Channel info and Content Program Manager start closed (secondary, edited
  // rarely); the video grid starts open since it's the main reason to be on this page at all.
  const [channelInfoOpen, setChannelInfoOpen] = useState(false);
  const [programManagerOpen, setProgramManagerOpen] = useState(false);
  const [videoGridOpen, setVideoGridOpen] = useState(true);
  const [showProgramManagerChat, setShowProgramManagerChat] = useState(false);
  // Local in-progress edits per stage, keyed by stage — undefined means "not yet touched this
  // session, fall back to channel.prompt_overrides[stage] or the stage's default text". Kept
  // separate from channel state so typing doesn't need a persist round-trip on every keystroke;
  // onBlur (savePromptOverride) is what persists.
  const [promptDrafts, setPromptDrafts] = useState({});
  // Which stage's version-history dropdown is open (null = none), plus that dropdown's own loading
  // state and fetched items — refetched every time it's opened rather than cached, so a restore
  // made moments ago always shows up.
  const [historyOpenStage, setHistoryOpenStage] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  // Read-only playlist panel — fetched on demand (button click) rather than on mount, since it's
  // one more YouTube API round-trip that most dashboard visits don't need.
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlists, setPlaylists] = useState(null);
  // "Move to another channel" — id of the video card whose inline selector is open (null = none),
  // only one at a time. Operates directly on the saved record from `videos` (already the full
  // saveVideo-shaped object — see fromVideoRow, src/lib/db.js), not on App.jsx's project/projectId
  // state, so a video can be moved without ever opening it.
  const [moveOpenForId, setMoveOpenForId] = useState(null);
  const [moveChannels, setMoveChannels] = useState([]);
  const [moveChannelsLoading, setMoveChannelsLoading] = useState(false);
  const [selectedMoveChannelId, setSelectedMoveChannelId] = useState('');
  const [movingId, setMovingId] = useState(null);
  const [moveError, setMoveError] = useState('');
  // "Link as Short" — id of the parent video card whose picker is open (null = none). Lets an
  // existing video on this channel be attached as this parent's companion Short (fix a wrong
  // association, or link a hand-made Short). Same inline-picker pattern as "move".
  const [linkShortForId, setLinkShortForId] = useState(null);
  const [selectedLinkShortId, setSelectedLinkShortId] = useState('');
  const [linkingShortId, setLinkingShortId] = useState(null);
  const [linkShortError, setLinkShortError] = useState('');
  // "Companion Short" card section — id of the video card whose section is expanded (null = all
  // collapsed). Collapsed by default; collapsed state shows only a one-line status. One at a time,
  // same as the move / YouTube-status / link pickers.
  const [shortSectionOpenFor, setShortSectionOpenFor] = useState(null);
  // "Edit YouTube status" — id of the video card whose popover is open (null = none), mutually
  // exclusive with the "move" popover above (opening one closes the other, see openYtEdit/
  // openMoveFor) so a single card never shows two overlapping inline panels at once.
  const [ytEditOpenForId, setYtEditOpenForId] = useState(null);
  const [ytIdInput, setYtIdInput] = useState('');
  const [ytEditBusy, setYtEditBusy] = useState(null); // videoId currently being saved, or null
  const [ytEditError, setYtEditError] = useState('');
  // ⚙ card action menu — id of the card whose dropdown is open (null = none). The ⚙ button is now a
  // menu (Edit YouTube status / Delete / …) rather than a single action; items come from an array
  // so a future action is one entry, not a card restructure.
  const [cardMenuOpenFor, setCardMenuOpenFor] = useState(null);

  // Escape closes the "how should this Short publish?" modal (same affordance as ImageLightbox /
  // ProgramManagerChat). No-op while nothing is generating; the modal itself also closes on the
  // choice and on an outside click.
  useEffect(() => {
    if (!shortPublishChoiceFor) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setShortPublishChoiceFor(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortPublishChoiceFor]);

  // Default background/text style for content_type 'static_background' videos on this channel —
  // see StoryboardStep.jsx, which seeds a new video's own project.staticBackground/staticTextStyle
  // from these exactly once.
  const [staticBgGenPrompt, setStaticBgGenPrompt] = useState('');
  const [staticBgBusy, setStaticBgBusy] = useState(false);
  const [staticBgError, setStaticBgError] = useState('');
  const [staticBgPreviewUrl, setStaticBgPreviewUrl] = useState('');

  // Re-signs the preview URL whenever the stored default image path changes (upload/generation
  // above, or a fresh page load) — same short-lived-signed-URL pattern as the video grid's own
  // thumbnail previews further down.
  useEffect(() => {
    const path = channel?.automation_static_bg_image_path;
    if (!path) {
      setStaticBgPreviewUrl('');
      return;
    }
    let cancelled = false;
    getMediaUrl(path)
      .then((url) => {
        if (!cancelled) setStaticBgPreviewUrl(url);
      })
      .catch((err) => console.error('[ChannelDashboardStep] failed to sign default background preview', err));
    return () => {
      cancelled = true;
    };
  }, [channel?.automation_static_bg_image_path]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ch, list, costs] = await Promise.all([loadChannel(channelId), listVideosByChannel(channelId), getCostsByChannel(channelId)]);
      if (cancelled) return;
      setChannel(ch || null);
      setName(ch?.name || '');
      setNiche(ch?.niche || '');
      setNotes(ch?.editorialNotes || '');
      // App.jsx holds the single source of truth for "the currently open channel" — every load and
      // every local mutation below reports here, so components that never do their own fetch (like
      // ExportStep) can't end up looking at a stale copy of e.g. the YouTube connection state.
      onChannelChange?.(ch || null);
      setVideos(sortVideosForGrid(list));
      setTotalSpent(costs.total);
      // Phase 3: the Blob itself never survives a reload (see stripBlobsForSync, src/lib/db.js) —
      // storagePath is the Supabase Storage backup, sign a short-lived URL to preview it. A video's
      // own thumbnail (generated to be representative of the whole video — see thumbnailEngine.js)
      // wins over its first scene's first image whenever one exists, regardless of content_type: a
      // thumbnail is a deliberate choice, a first scene image is just whatever happened to be scene
      // 1. Videos that never reached either (or whose backup failed) have no storagePath, and keep
      // the "No preview" placeholder.
      const urls = {};
      for (const v of list) {
        const storagePath = v.thumbnailStoragePath || v.scenes?.[0]?.images?.[0]?.storagePath;
        if (!storagePath) continue;
        try {
          urls[v.id] = await getMediaUrl(storagePath);
        } catch (err) {
          console.error('[getMediaUrl] failed to sign video preview thumbnail', storagePath, err);
        }
      }
      if (cancelled) return;
      setThumbUrls(urls);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // While a companion Short is still being produced (its own pipeline, or a Gemini Batch job the
  // background poll will finish), refresh the grid every 20s so the parent card flips from
  // "⏳ Short generating…" to "🎬 View Short" without a manual reload.
  useEffect(() => {
    if (!Array.isArray(videos)) return undefined;
    const stillGenerating = videos.some((v) => v.isShort === true && !v.youtubeVideoId && !v.thumbnailStoragePath);
    if (!stillGenerating) return undefined;
    const id = setInterval(() => {
      refreshVideos();
    }, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  async function saveName() {
    if (!channel) return;
    const trimmed = name.trim();
    // A channel must always have a name — silently revert to the last saved one rather than
    // persisting a blank, same as leaving the "Channel name" field empty in the creation form.
    if (!trimmed) {
      setName(channel.name || '');
      return;
    }
    if (trimmed === (channel.name || '')) return;
    const updated = await updateChannelFields(channel.id, { name: trimmed });
    if (!updated) return;
    setChannel(updated);
    setName(updated.name || '');
    onChannelChange?.(updated);
  }

  async function saveNiche() {
    if (!channel || niche === (channel.niche || '')) return;
    const updated = await updateChannelFields(channel.id, { niche });
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function saveNotes() {
    if (!channel || notes === (channel.editorialNotes || '')) return;
    const updated = await updateChannelFields(channel.id, { editorial_notes: notes });
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function saveContentType(value) {
    if (!channel) return;
    const updated = await updateChannelFields(channel.id, { content_type: value });
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function saveChannelIntro(value) {
    if (!channel) return;
    const updated = await updateChannelFields(channel.id, { automation_channel_intro: value });
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  // Persists one stage's creative-direction override — an empty/whitespace-only value, or a value
  // that exactly matches the stage's default text (the textarea's un-overridden starting value,
  // now real editable text rather than a placeholder — see PROMPT_STAGES.map below), both collapse
  // to "no override" rather than storing the default text back as if it were a custom one.
  async function savePromptOverride(stage, value) {
    if (!channel) return;
    const trimmed = (value || '').trim();
    const isDefaultText = trimmed === (DEFAULT_CREATIVE_DIRECTION[stage] || '').trim();
    const effectiveNext = isDefaultText ? '' : trimmed;
    const current = channel.prompt_overrides?.[stage] || '';
    if (effectiveNext === current) return;
    const nextOverrides = { ...(channel.prompt_overrides || {}) };
    if (effectiveNext) nextOverrides[stage] = effectiveNext;
    else delete nextOverrides[stage];
    const [updated] = await Promise.all([
      updateChannelFields(channel.id, { prompt_overrides: nextOverrides }),
      // Only real custom content is worth a version entry — reverting to the default (or clearing)
      // isn't a "version" of anything, and savePromptVersion no-ops on an empty string anyway.
      effectiveNext ? savePromptVersion(channel.id, stage, effectiveNext) : Promise.resolve(null),
    ]);
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  // Persists the Content Program Manager chat (ProgramManagerChat.jsx). Targeted update of only the
  // program_manager_chat column, so it can't clobber a prompt_overrides change ProgramManagerChat's
  // own onApplyUpdate (savePromptOverride) may have landed moments before, nor anything the
  // automation cycle touched. history is null to clear the chat ("New conversation"), or the array
  // of { role, content } turns to persist otherwise.
  async function saveProgramManagerChat(history) {
    if (!channelId) return;
    setChannel((prev) => (prev ? { ...prev, program_manager_chat: history } : prev)); // optimistic
    const updated = await updateChannelFields(channelId, { program_manager_chat: history });
    if (!updated) return;
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function toggleHistory(stage) {
    if (historyOpenStage === stage) {
      setHistoryOpenStage(null);
      return;
    }
    setHistoryOpenStage(stage);
    setHistoryLoading(true);
    try {
      const items = await listPromptVersions(channel.id, stage);
      setHistoryItems(items);
    } finally {
      setHistoryLoading(false);
    }
  }

  // Restoring is a plain save through the same path every other edit takes — it becomes a new
  // version entry itself (assuming it differs from whatever's most recent), no special-casing.
  async function restoreVersion(stage, content) {
    setPromptDrafts((d) => ({ ...d, [stage]: content }));
    await savePromptOverride(stage, content);
    setHistoryOpenStage(null);
  }

  // Fetches (or, within the 24h cache window, simply reads) the shared Content Program Manager
  // result — see src/lib/contentProgramManager.js. A refinement note always forces a fresh pass
  // (it needs new reasoning), everything else respects the cache as-is.
  async function fetchSuggestions(refinementText) {
    if (!channel) return;
    setSuggestionsLoading(true);
    setSuggestionsError('');
    try {
      const { channel: updated } = await getTopicSuggestions(channel, {
        videos,
        forceRefresh: !!refinementText,
        refinementText: refinementText || '',
      });
      setChannel(updated);
      onChannelChange?.(updated);
      setRefiningIndex(null);
      setRefineText('');
    } catch (e) {
      setSuggestionsError(String(e.message || e));
    } finally {
      setSuggestionsLoading(false);
    }
  }

  // "Start this video" — removes the suggestion immediately (before the backfill round-trip even
  // begins) so the list never keeps showing an idea that's already being turned into a video, even
  // if the user navigates back here before the background backfill arrives. Same shared
  // remove-and-backfill mechanics the automation recipes use (startTopicSuggestion) — a video
  // started from either surface disappears from both.
  function startSuggestion(s) {
    onStartVideoFromSuggestion?.(s.title, s.series || null);
    // This suggestion is api/program-manager.js's answer to a pending promise from an earlier
    // video's closing CTA — mark that ORIGINAL video as fulfilled now, so it stops showing up in
    // future pendingPromises lists. Fire-and-forget: loads the record fresh (not from local
    // `videos` state, which may be stale) rather than blocking the rest of this click's flow on it.
    if (s.fulfills_promise_video_id) {
      loadVideo(s.fulfills_promise_video_id)
        .then((v) => (v ? saveVideo({ ...v, promiseFulfilled: true }) : null))
        .catch((err) => console.error('[ChannelDashboardStep] failed to mark promise as fulfilled', err));
    }
    let latestChannel;
    setChannel((prev) => {
      if (!prev) return prev;
      const finalSuggestions = (prev.topic_scoring_cache?.finalSuggestions || []).filter((x) => x.title !== s.title);
      latestChannel = { ...prev, topic_scoring_cache: { ...prev.topic_scoring_cache, finalSuggestions } };
      return latestChannel;
    });
    if (!latestChannel) return;
    setAwaitingReplacement(true);
    startTopicSuggestion(latestChannel, s, videos)
      .then((updated) => {
        setChannel(updated);
        onChannelChange?.(updated);
      })
      .catch((err) => console.error('[ChannelDashboardStep] failed to start/backfill suggestion', err))
      .finally(() => setAwaitingReplacement(false));
  }

  // "Not interested" — same remove-and-backfill mechanics as startSuggestion, plus remembering the
  // title (dismissed_suggestions) so it never resurfaces in a future backfill or full regeneration.
  function dismissSuggestion(s) {
    let latestChannel;
    setChannel((prev) => {
      if (!prev) return prev;
      const finalSuggestions = (prev.topic_scoring_cache?.finalSuggestions || []).filter((x) => x.title !== s.title);
      const dismissed_suggestions = [...(prev.dismissed_suggestions || []), s.title].filter(Boolean).slice(-50);
      latestChannel = {
        ...prev,
        topic_scoring_cache: { ...prev.topic_scoring_cache, finalSuggestions },
        dismissed_suggestions,
      };
      return latestChannel;
    });
    if (!latestChannel) return;
    setAwaitingReplacement(true);
    dismissTopicSuggestion(latestChannel, s, videos)
      .then((updated) => {
        setChannel(updated);
        onChannelChange?.(updated);
      })
      .catch((err) => console.error('[ChannelDashboardStep] failed to dismiss/backfill suggestion', err))
      .finally(() => setAwaitingReplacement(false));
  }

  // Compact "📈 Trending +34% (7d) · 12 recent videos, avg 340 views" badge line for a suggestion
  // card — built straight from the real Trends/YouTube data api/topic-scoring.js attached to it, so
  // it's absent (not fabricated) for fallback ideas that were never scored (see
  // src/lib/contentProgramManager.js's fetchFallbackSuggestion). Returns null when there's nothing
  // real to show.
  function formatSignalSummary(s) {
    const parts = [];
    const trends = s?.trends;
    const d7 = trends?.deltas?.d7;
    if (trends && !trends.error && d7 && d7.delta_pct !== null && d7.delta_pct !== undefined) {
      const pct = Math.round(d7.delta_pct);
      parts.push(`${pct >= 0 ? '📈 Trending +' : '📉 Trending '}${pct}% (7d)`);
    } else if (trends?.error) {
      parts.push('📈 Trend data unavailable');
    }
    const competition = s?.competition;
    if (competition && !competition.error) {
      const { video_count, avg_views } = competition.summary || {};
      parts.push(video_count ? `${video_count} recent videos, avg ${Math.round(avg_views || 0).toLocaleString()} views` : 'no recent videos found');
    } else if (competition?.error) {
      parts.push('competition data unavailable');
    }
    if (!parts.length) return null;
    return parts.join(' · ') + (s.signal_incomplete ? ' (partial data)' : '');
  }

  async function togglePlaylists() {
    if (playlistsOpen) {
      setPlaylistsOpen(false);
      return;
    }
    setPlaylistsOpen(true);
    setPlaylistsLoading(true);
    try {
      const list = await listChannelPlaylists(channel);
      setPlaylists(list);
    } finally {
      setPlaylistsLoading(false);
    }
  }

  async function handleConnectYoutube() {
    try {
      const res = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auth-url', channelId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the YouTube connection');
      window.location.href = data.authUrl;
    } catch (e) {
      window.alert(String(e.message || e));
    }
  }

  async function handleDisconnectYoutube() {
    if (!window.confirm('Disconnect this channel from YouTube?')) return;
    const updated = await clearYoutubeConnection(channelId);
    setChannel(updated);
    onChannelChange?.(updated);
  }

  // Instant-save for the simple defaults below (color pickers, outline toggle, background image
  // path). Targeted update — `patch` keys are already DB column names — so it only ever writes the
  // one or two fields that changed, never the whole row.
  async function updateStaticDefaults(patch) {
    if (!channel) return;
    try {
      const updated = await updateChannelFields(channel.id, patch);
      if (!updated) return;
      setChannel(updated);
      onChannelChange?.(updated);
    } catch (err) {
      console.error('[ChannelDashboardStep] failed to save static background defaults', err);
    }
  }

  async function handleUploadStaticBgImage(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file || !channel) return;
    setStaticBgBusy(true);
    setStaticBgError('');
    try {
      const path = await uploadMedia(userId, channelDefaultsPseudoVideoId(channelId), 'static-bg-default', 'bg', file);
      await updateStaticDefaults({ automation_static_bg_image_path: path });
    } catch (err) {
      setStaticBgError('Upload failed: ' + String(err.message || err));
    } finally {
      setStaticBgBusy(false);
    }
  }

  // Same single-still-image gateway StoryboardStep.jsx's own background section uses — one plain
  // generateImage call, nanobanana-batch has no single-image endpoint of its own so it falls back
  // to nanobanana's synchronous one (same reasoning as thumbnailEngine.js).
  async function handleGenerateStaticBgImage() {
    const trimmed = staticBgGenPrompt.trim();
    if (!trimmed || !channel) {
      setStaticBgError('Enter a description for the background image.');
      return;
    }
    const provider = channel.automation_image_provider === 'nanobanana-batch' ? 'nanobanana' : channel.automation_image_provider || 'pollinations';
    const cost = priceForImage(provider, { width: 1280, height: 720, quality: 'medium', hasReference: false });
    if (cost > 0 && !window.confirm(`Generate this default background image using ${provider} (~$${cost.toFixed(2)})?`)) return;
    setStaticBgBusy(true);
    setStaticBgError('');
    try {
      const { imageUrl, costUsd } = await generateImage(trimmed, provider, [], {
        width: 1280,
        height: 720,
        seed: Math.floor(Math.random() * 999999),
        quality: 'medium',
      });
      if (costUsd > 0) await recordCost({ channelId, videoId: null, provider, type: 'image', amountUsd: costUsd });
      const blob = await (await fetch(imageUrl)).blob();
      const path = await uploadMedia(userId, channelDefaultsPseudoVideoId(channelId), 'static-bg-default', 'bg', blob);
      await updateStaticDefaults({ automation_static_bg_image_path: path });
    } catch (err) {
      setStaticBgError('Generation failed: ' + String(err.message || err));
    } finally {
      setStaticBgBusy(false);
    }
  }

  async function handleDeleteChannel() {
    if (!window.confirm(`Delete "${channel?.name || 'this channel'}"? This also deletes all ${videos?.length || 0} of its videos and cannot be undone.`)) return;
    await deleteChannel(channelId);
    onBack();
  }

  async function handleDeleteVideo(id) {
    const v = (videos || []).find((x) => x.id === id);
    const hasShort = !!v?.shortVideoId;
    if (
      !window.confirm(
        hasShort
          ? 'Delete this video and its companion Short? Both records and all their media are removed permanently. A Short already on YouTube stays on YouTube. This cannot be undone.'
          : 'Delete this video? This cannot be undone.'
      )
    )
      return;
    // Purges the video's (and, cascaded, its Short's) DB row + all Supabase Storage media.
    const removed = await deleteVideoAndMedia(userId, id);
    const removedSet = new Set(removed);
    setVideos((list) => list.filter((x) => !removedSet.has(x.id)));
  }

  async function refreshVideos() {
    try {
      const fresh = await listVideosByChannel(channelId);
      setVideos(sortVideosForGrid(fresh));
    } catch (err) {
      console.error('[ChannelDashboardStep] failed to refresh videos', err);
    }
  }

  // Manual "Generate Short" on a published video's card — runs the exact same path the automatic
  // companion-Short hook does (createShortRecord builds the record, then runFullPipeline produces
  // it), on THIS parent, regardless of channel.automation_generate_shorts. runManagedResume takes
  // the same scheduler lock a cycle uses.
  //
  // autoPublish is the user's explicit choice in the popup that precedes this call:
  //   true  → once the thumbnail is done the Short goes straight to YouTube, bypassing the channel's
  //           automation_auto_publish toggle (manualPublish:true) — the human asked for exactly this
  //           publish, right now.
  //   false → the Short stops fully produced ("◻ produced, not on YouTube yet") for manual review
  //           and publishing from Export (skipPublish:true).
  async function handleGenerateShort(v, { autoPublish } = {}) {
    if (generatingShortFor) return;
    if (!v.youtubeVideoId) return;
    if (typeof autoPublish !== 'boolean') return; // must come from the popup choice
    setShortPublishChoiceFor(null);
    setGeneratingShortFor(v.id);
    let started = false;
    try {
      const shortId = await createShortRecord(
        {
          id: v.id,
          youtubeVideoId: v.youtubeVideoId,
          topic: v.topic || v.displayTitle || '',
          angle: v.angle || '',
          subject: v.subject || null,
          characterBible: Array.isArray(v.characterBible) ? v.characterBible : [],
          displayTitle: v.displayTitle || v.topic || '',
        },
        channel,
        { userId, logStep }
      );
      // Point the parent at its new Short — same link the automatic hook writes.
      try {
        const parentFresh = await loadVideo(v.id);
        if (parentFresh) await saveVideo({ ...parentFresh, shortVideoId: shortId });
      } catch (err) {
        console.error('[ChannelDashboardStep] failed to link parent → Short (Short will still generate)', v.id, err);
      }
      await refreshVideos(); // card now shows "⏳ Short generating…"
      // Produce + publish it through the whole pipeline, under the cycle's lock so the two can't
      // overlap. onProgress feeds the SAME live mirror a scheduled cycle / manual resume feeds — so
      // the Automation-status page shows this Short's current phase, render % and upload %, and the
      // Short gets the green "working" border in "Videos in progress" while it runs.
      const result = await runManagedResume(() =>
        runFullPipeline(channel, {
          targetVideoId: shortId,
          userId,
          logStep,
          onProgress: (evt) => onRunProgress?.({ channelId: channel.id, channelName: channel.name, ...evt }),
          // The popup choice: force the YouTube publish, or stop fully produced for manual review.
          ...(autoPublish ? { manualPublish: true } : { skipPublish: true }),
        })
      );
      started = !!(result && result.started);
      if (result && result.started === false) {
        window.alert(
          `The Short was created but its generation couldn't start right now — ${result.reason}. It'll be picked up automatically on the next automation cycle.`
        );
      }
      await refreshVideos();
    } catch (err) {
      console.error('[ChannelDashboardStep] Generate Short failed', v.id, err);
      window.alert(`Could not generate the Short: ${String(err.message || err)}`);
      await refreshVideos();
    } finally {
      setGeneratingShortFor(null);
      // Only clear the mirror if THIS action actually drove it — a blocked attempt (started false)
      // never touched onProgress, and wiping here could erase a concurrent cycle's live state.
      if (started) onRunEnd?.();
    }
  }

  async function openMoveFor(v) {
    setYtEditOpenForId(null);
    setCardMenuOpenFor(null);
    setMoveOpenForId(v.id);
    setMoveError('');
    setMoveChannelsLoading(true);
    try {
      const all = await listChannels();
      const others = all.filter((c) => c.id !== channelId);
      setMoveChannels(others);
      setSelectedMoveChannelId(others[0]?.id || '');
    } catch (err) {
      setMoveError('Could not load channels: ' + String(err.message || err));
    } finally {
      setMoveChannelsLoading(false);
    }
  }

  function closeMove() {
    setMoveOpenForId(null);
    setMoveError('');
  }

  // v is the full record from `videos` (id, channelId, createdAt, topic, settings, displayTitle,
  // plus every project field — see fromVideoRow, src/lib/db.js), so saveVideo({ ...v, channelId })
  // is a faithful re-save of exactly what's already on the row, just under a different channel —
  // no in-memory project/projectId state needed, unlike the version of this that used to live in
  // ExportStep.jsx and required the video to already be open.
  async function confirmMoveVideo(v) {
    const target = moveChannels.find((c) => c.id === selectedMoveChannelId);
    if (!target) return;
    const fromName = channel?.name || 'this channel';
    const toName = target.name || 'Untitled channel';
    const title = v.displayTitle || 'Untitled video';
    const ok = window.confirm(
      `Move "${title}" from "${fromName}" to "${toName}"?\n\nIt will disappear from ${fromName}'s dashboard and appear under ${toName} instead.`
    );
    if (!ok) return;
    setMovingId(v.id);
    setMoveError('');
    try {
      await saveVideo({ ...v, channelId: target.id });
      // The moved video no longer belongs here — reload from the server rather than just filtering
      // it out locally, so the grid reflects exactly what's actually saved.
      const fresh = await listVideosByChannel(channelId);
      setVideos(sortVideosForGrid(fresh));
      setMoveOpenForId(null);
    } catch (err) {
      setMoveError('Move failed: ' + String(err.message || err));
    } finally {
      setMovingId(null);
    }
  }

  function openLinkShortFor(v) {
    setMoveOpenForId(null);
    setYtEditOpenForId(null);
    setLinkShortError('');
    setLinkShortForId(v.id);
    const candidates = (videos || []).filter((x) => x.id !== v.id);
    setSelectedLinkShortId(candidates[0]?.id || '');
  }

  function closeLinkShort() {
    setLinkShortForId(null);
    setLinkShortError('');
  }

  const titleOf = (id) => (videos || []).find((x) => x.id === id)?.displayTitle || 'another video';

  // Attach an EXISTING video on this channel as `parent`'s companion Short. Only the three link
  // fields are touched, each via updateVideoFields (targeted, read-fresh-merge-write — never a full
  // re-save of a stale copy): isShort/parentVideoId on the chosen video, shortVideoId on the parent,
  // plus unlinking whatever was linked before on either side so nothing ends up double-linked or
  // orphaned-but-hidden.
  async function confirmLinkShort(parent) {
    const chosen = (videos || []).find((x) => x.id === selectedLinkShortId);
    if (!chosen || chosen.id === parent.id) return;

    const alreadyShortElsewhere = chosen.parentVideoId && chosen.parentVideoId !== parent.id;
    const parentHasDifferentShort = parent.shortVideoId && parent.shortVideoId !== chosen.id;

    if (alreadyShortElsewhere) {
      if (
        !window.confirm(
          `"${chosen.displayTitle || 'This video'}" is already linked as a Short of "${titleOf(chosen.parentVideoId)}" — relink it to "${parent.displayTitle || 'this video'}" instead?\n\n"${titleOf(chosen.parentVideoId)}" will no longer show a companion Short.`
        )
      ) {
        return;
      }
    }
    if (parentHasDifferentShort) {
      if (
        !window.confirm(
          `"${parent.displayTitle || 'This video'}" already has a companion Short ("${titleOf(parent.shortVideoId)}").\n\nLinking this one will unlink the previous Short — it becomes a normal video again and reappears in the grid.`
        )
      ) {
        return;
      }
    }

    setLinkingShortId(parent.id);
    setLinkShortError('');
    try {
      // Unlink the old associations first — best-effort, so a dangling id (a since-deleted video)
      // on either side can't block the relink itself.
      if (parentHasDifferentShort) {
        try {
          await updateVideoFields(parent.shortVideoId, { isShort: false, parentVideoId: null });
        } catch (err) {
          console.error('[ChannelDashboardStep] could not unlink previous Short', parent.shortVideoId, err);
        }
      }
      if (alreadyShortElsewhere) {
        try {
          await updateVideoFields(chosen.parentVideoId, { shortVideoId: null });
        } catch (err) {
          console.error('[ChannelDashboardStep] could not clear old parent link', chosen.parentVideoId, err);
        }
      }
      // Link the new one — these two must succeed.
      await updateVideoFields(chosen.id, { isShort: true, parentVideoId: parent.id });
      await updateVideoFields(parent.id, { shortVideoId: chosen.id });
      await refreshVideos();
      setLinkShortForId(null);
    } catch (err) {
      setLinkShortError('Link failed: ' + String(err.message || err));
    } finally {
      setLinkingShortId(null);
    }
  }

  function openYtEdit(v) {
    setMoveOpenForId(null);
    setCardMenuOpenFor(null);
    setYtEditOpenForId(v.id);
    setYtIdInput('');
    setYtEditError('');
  }

  function closeYtEdit() {
    setYtEditOpenForId(null);
    setYtEditError('');
  }

  // v is the full record from `videos` (same shape confirmMoveVideo above already relies on) —
  // saveVideo({ ...v, youtubeVideoId }) is a faithful re-save of exactly what's on the row with
  // only that one field changed, no need to open the video first.
  async function markAsPublished(v) {
    const id = extractYoutubeId(ytIdInput);
    if (!id) {
      setYtEditError('Enter a YouTube video ID or URL.');
      return;
    }
    setYtEditBusy(v.id);
    setYtEditError('');
    try {
      await saveVideo({ ...v, youtubeVideoId: id, youtubePublishedAt: v.youtubePublishedAt || Date.now() });
      const fresh = await listVideosByChannel(channelId);
      setVideos(sortVideosForGrid(fresh));
      setYtEditOpenForId(null);
    } catch (err) {
      setYtEditError('Failed to save: ' + String(err.message || err));
    } finally {
      setYtEditBusy(null);
    }
  }

  async function markAsNotPublished(v) {
    const ok = window.confirm(
      'Mark this video as NOT published on YouTube?\n\nThis re-enables a full upload for this video — only do this if it was actually removed from YouTube, otherwise using it by mistake could result in a duplicate upload.'
    );
    if (!ok) return;
    setYtEditBusy(v.id);
    setYtEditError('');
    try {
      await saveVideo({ ...v, youtubeVideoId: null });
      const fresh = await listVideosByChannel(channelId);
      setVideos(sortVideosForGrid(fresh));
      setYtEditOpenForId(null);
    } catch (err) {
      setYtEditError('Failed to save: ' + String(err.message || err));
    } finally {
      setYtEditBusy(null);
    }
  }

  if (videos === null) {
    return <div style={{ ...card, textAlign: 'center', color: T.textSecondary, fontFamily: FONT.ui, fontSize: 13 }}>Loading your videos…</div>;
  }

  // Companion Shorts (isShort) are never their own grid card — they're surfaced inside their parent
  // video's card via parentVideoId ↔ the parent's shortVideoId. shortsById lets a parent card read
  // its Short's state without another query.
  const shortsById = new Map();
  const gridVideos = [];
  for (const v of videos) {
    if (v.isShort === true) shortsById.set(v.id, v);
    else gridVideos.push(v);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setNameFocused(false);
                saveName();
              }}
              onFocus={() => setNameFocused(true)}
              placeholder="Channel name"
              style={{
                fontFamily: FONT.display,
                fontSize: 24,
                color: T.text,
                border: 'none',
                borderBottom: `1px solid ${nameFocused ? T.border : 'transparent'}`,
                padding: 0,
                background: 'transparent',
                outline: 'none',
                width: '100%',
              }}
            />
            <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
              {channel?.youtube_connected ? `✓ Connected to ${channel.youtube_channel_name || 'YouTube channel'}` : 'Not connected'} · 💰 $
              {totalSpent.toFixed(2)} spent
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onBack} style={btnGhost}>
              ← All channels
            </button>
            <button onClick={handleDeleteChannel} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
              Delete channel
            </button>
          </div>
        </div>

        <button
          onClick={() => setChannelInfoOpen((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
            marginTop: 16,
          }}
        >
          <span style={label}>Channel details</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {channelInfoOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>

        {channelInfoOpen && (
          <>
            <div style={{ marginTop: 16 }}>
              <div style={label}>Niche</div>
              <ExpandableTextarea
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                onBlur={saveNiche}
                placeholder="Niche (optional)"
                rows={2}
                style={{ ...inputStyle, marginTop: 8, resize: 'vertical' }}
              />
            </div>
            <div style={{ marginTop: 16 }}>
              <div style={label}>Editorial notes</div>
              <ExpandableTextarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="Tone, recurring formats, things to avoid…"
                rows={2}
                style={{ ...inputStyle, marginTop: 8, resize: 'vertical' }}
              />
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={label}>Content type</div>
              <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 4, marginBottom: 8 }}>
                Also used for videos created manually from Create — not automation-only.
              </div>
              <select
                value={channel?.content_type || ''}
                onChange={(e) => saveContentType(e.target.value)}
                style={{ ...inputStyle, maxWidth: 320 }}
              >
                <option value="">— Select —</option>
                {CONTENT_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>
                    {ct.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={channel?.automation_channel_intro === true}
                  onChange={(e) => saveChannelIntro(e.target.checked)}
                />
                Include channel intro at video start
              </label>
              <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
                When enabled, videos open with a brief welcome that introduces the channel's purpose (using your
                Niche description) — useful for language-learning or narration-focused channels where listeners
                benefit from knowing what to expect.
              </div>
            </div>

            <div
              style={{
                borderTop: `1px solid ${T.border}`,
                marginTop: 16,
                paddingTop: 16,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
              }}
            >
              <div>
                <div style={label}>YouTube</div>
                {channel?.youtube_connected ? (
                  <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.text, marginTop: 6 }}>
                    ✓ Connected to {channel.youtube_channel_name || 'YouTube channel'}
                  </div>
                ) : (
                  <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
                    Connect this channel's YouTube account to enable direct upload.
                  </div>
                )}
              </div>
              {channel?.youtube_connected ? (
                <button onClick={handleDisconnectYoutube} style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder }}>
                  Disconnect
                </button>
              ) : (
                <button onClick={handleConnectYoutube} style={btnPrimary}>
                  Connect YouTube channel
                </button>
              )}
            </div>

            {channel?.youtube_connected && (
              <div style={{ marginTop: 12 }}>
                <button onClick={togglePlaylists} style={{ ...btnGhost, padding: '6px 12px', fontSize: 11 }}>
                  📂 {playlistsOpen ? 'Hide' : 'View'} channel playlists
                </button>
                {playlistsOpen && (
                  <div style={{ marginTop: 10, border: `1px solid ${T.border}`, borderRadius: 4, padding: 10, maxHeight: 220, overflowY: 'auto' }}>
                    {playlistsLoading ? (
                      <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>Loading…</div>
                    ) : !playlists || playlists.length === 0 ? (
                      <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>No playlists found on this channel.</div>
                    ) : (
                      playlists.map((p, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 10,
                            padding: '6px 0',
                            borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                            fontSize: 12,
                            fontFamily: FONT.ui,
                            color: T.text,
                          }}
                        >
                          <span>{p.name}</span>
                          <span style={{ ...mono, color: T.textMuted }}>
                            {p.videoCount} video{p.videoCount === 1 ? '' : 's'}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {channel?.content_type === 'static_background' && (
        <div style={card}>
          <div style={label}>Default video settings — Static Background</div>
          <div style={{ fontSize: 12, color: T.textSecondary, fontFamily: FONT.ui, marginTop: 6, lineHeight: 1.5 }}>
            Applied to every new video on this channel until changed for that specific video (see Storyboard).
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={label}>Default background</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                Solid color
                <input
                  type="color"
                  value={channel?.automation_static_bg_color || '#111111'}
                  onChange={(e) => updateStaticDefaults({ automation_static_bg_color: e.target.value })}
                  style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                />
              </label>
            </div>

            {staticBgPreviewUrl && (
              <>
                <img
                  src={staticBgPreviewUrl}
                  alt="Default background"
                  style={{ width: '100%', maxWidth: 280, borderRadius: 4, border: `1px solid ${T.border}`, marginTop: 10, display: 'block' }}
                />
                <button
                  onClick={() => updateStaticDefaults({ automation_static_bg_image_path: null })}
                  style={{ ...btnGhost, marginTop: 8, padding: '6px 10px', fontSize: 11 }}
                >
                  ✕ Remove image
                </button>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ ...btnGhost, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                Upload image
                <input type="file" accept="image/*" onChange={handleUploadStaticBgImage} style={{ display: 'none' }} />
              </label>
              <input
                value={staticBgGenPrompt}
                onChange={(e) => setStaticBgGenPrompt(e.target.value)}
                placeholder="…or describe an image to generate"
                style={{ ...inputStyle, flex: 1, minWidth: 180 }}
              />
              <button onClick={handleGenerateStaticBgImage} disabled={staticBgBusy} style={{ ...btnPrimary, opacity: staticBgBusy ? 0.6 : 1 }}>
                {staticBgBusy ? 'Working…' : 'Generate'}
              </button>
            </div>
            {staticBgError && <div style={{ marginTop: 8, fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{staticBgError}</div>}
          </div>

          <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <div style={label}>Default text style</div>
            <div style={{ display: 'flex', gap: 18, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                Text color
                <input
                  type="color"
                  value={channel?.automation_static_text_color || '#FFFFFF'}
                  onChange={(e) => updateStaticDefaults({ automation_static_text_color: e.target.value })}
                  style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                <input
                  type="checkbox"
                  checked={channel?.automation_static_text_outline !== false}
                  onChange={(e) => updateStaticDefaults({ automation_static_text_outline: e.target.checked })}
                />
                Outline
              </label>
              {channel?.automation_static_text_outline !== false && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: FONT.ui, color: T.text }}>
                  Outline color
                  <input
                    type="color"
                    value={channel?.automation_static_text_outline_color || '#000000'}
                    onChange={(e) => updateStaticDefaults({ automation_static_text_outline_color: e.target.value })}
                    style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, cursor: 'pointer' }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={card}>
        <button
          onClick={() => setShowPromptLab((v) => !v)}
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
          <span style={label}>Prompt Lab</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {showPromptLab ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>

        {showPromptLab && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>
              Edit the creative direction each AI generation step follows for this channel — tone, editorial priorities, how to write titles, outlines and scenes. The technical output format each step must return is fixed and shown read-only below its editor.
            </div>

            {PROMPT_STAGES.map(({ key, stageLabel }) => {
              // Never blank: an absent/empty override falls back to the stage's default text as a
              // real, immediately-editable value — not a placeholder — so the field always shows
              // exactly what a generation would use right now.
              const draftValue =
                promptDrafts[key] !== undefined ? promptDrafts[key] : channel?.prompt_overrides?.[key] || DEFAULT_CREATIVE_DIRECTION[key];
              const hasOverride = !!(channel?.prompt_overrides?.[key] || '').trim();
              const isHistoryOpen = historyOpenStage === key;
              return (
                <div key={key} style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontFamily: FONT.ui, fontSize: 13, fontWeight: 700, color: T.text }}>{stageLabel}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => toggleHistory(key)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 9 }}>
                        🕐 History
                      </button>
                      {hasOverride && (
                        <button
                          onClick={() => {
                            setPromptDrafts((d) => ({ ...d, [key]: DEFAULT_CREATIVE_DIRECTION[key] }));
                            savePromptOverride(key, '');
                          }}
                          style={{ ...btnGhost, padding: '5px 10px', fontSize: 9 }}
                        >
                          Reset to default
                        </button>
                      )}
                    </div>
                  </div>

                  {isHistoryOpen && (
                    <div
                      style={{
                        marginTop: 8,
                        border: `1px solid ${T.border}`,
                        borderRadius: 4,
                        maxHeight: 220,
                        overflowY: 'auto',
                      }}
                    >
                      {historyLoading ? (
                        <div style={{ padding: 10, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>Loading…</div>
                      ) : historyItems.length === 0 ? (
                        <div style={{ padding: 10, fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>
                          No saved versions yet — versions are recorded whenever you edit and leave this field.
                        </div>
                      ) : (
                        historyItems.map((v) => (
                          <div
                            key={v.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 10,
                              padding: 10,
                              borderTop: `1px solid ${T.border}`,
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ ...mono, fontSize: 10, color: T.textMuted }}>{timeAgo(v.createdAt)}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: T.textSecondary,
                                  fontFamily: FONT.ui,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {v.content.slice(0, 60)}
                                {v.content.length > 60 ? '…' : ''}
                              </div>
                            </div>
                            <button
                              onClick={() => restoreVersion(key, v.content)}
                              style={{ ...btnGhost, padding: '5px 10px', fontSize: 9, flexShrink: 0 }}
                            >
                              Restore
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <div
                    style={{
                      marginTop: 8,
                      padding: 10,
                      borderRadius: 4,
                      background: T.surfaceAlt,
                      color: T.textMuted,
                      fontSize: 11,
                      fontFamily: FONT.mono,
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      maxHeight: 140,
                      overflowY: 'auto',
                    }}
                  >
                    <div style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                      Technical format — not editable
                    </div>
                    {SCHEMA_INSTRUCTIONS_DISPLAY[key]}
                  </div>

                  <ExpandableTextarea
                    value={draftValue}
                    onChange={(e) => setPromptDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onBlur={() => savePromptOverride(key, draftValue)}
                    rows={5}
                    style={{ ...inputStyle, marginTop: 10, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <button
          onClick={() => setProgramManagerOpen((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div>
            <div style={label}>Content Program Manager</div>
            {channel?.topic_scoring_cache?.generatedAt && (
              <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>generated {timeAgo(channel.topic_scoring_cache.generatedAt)}</div>
            )}
          </div>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {programManagerOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>

        {programManagerOpen && (
          <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={() => setShowProgramManagerChat(true)} style={btnGhost}>
            💬 Talk to your Content Manager
          </button>
          <button onClick={() => fetchSuggestions('')} disabled={suggestionsLoading} style={{ ...btnPrimary, opacity: suggestionsLoading ? 0.6 : 1 }}>
            {suggestionsLoading ? 'Working…' : channel?.topic_scoring_cache ? 'Refresh suggestions' : 'Suggest next videos'}
          </button>
        </div>

        {suggestionsLoading && (
          <div style={{ ...mono, fontSize: 12, color: T.textSecondary, marginTop: 14 }}>
            Analyzing your channel and researching the niche… ~30-60s
          </div>
        )}

        {suggestionsError && !suggestionsLoading && (
          <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui, marginTop: 14 }}>{suggestionsError}</div>
        )}

        {channel?.topic_scoring_cache && !suggestionsLoading && (
          <div style={{ marginTop: 16 }}>
            {channel.topic_scoring_cache.analysis && (
              <div
                style={{
                  fontFamily: FONT.ui,
                  fontSize: 13,
                  color: T.text,
                  lineHeight: 1.6,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                {channel.topic_scoring_cache.analysis}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {(channel.topic_scoring_cache.finalSuggestions || []).map((s, i) => (
                <div
                  key={i}
                  style={{
                    border: s.series ? `1px solid ${T.primaryBorder}` : `1px solid ${T.border}`,
                    background: s.series ? T.primaryLight : '#FFFFFF',
                    borderRadius: 4,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        ...mono,
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: priorityColor(s.priority),
                        border: `1px solid ${priorityColor(s.priority)}`,
                        borderRadius: 3,
                        padding: '2px 6px',
                      }}
                    >
                      {s.priority || 'medium'}
                    </span>
                    {s.series && (
                      <span
                        style={{
                          ...mono,
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: T.primary,
                          background: '#FFFFFF',
                          border: `1px solid ${T.primaryBorder}`,
                          borderRadius: 3,
                          padding: '2px 6px',
                        }}
                      >
                        Series: {s.series}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{s.title}</div>
                  <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>{s.angle}</div>
                  {formatSignalSummary(s) && (
                    <div style={{ ...mono, fontSize: 11, color: T.textMuted, lineHeight: 1.4 }}>{formatSignalSummary(s)}</div>
                  )}
                  {s.rationale && (
                    <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5, fontStyle: 'italic' }}>{s.rationale}</div>
                  )}

                  <div style={{ display: 'flex', gap: 6, marginTop: 'auto', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => startSuggestion(s)}
                      style={{ ...btnPrimary, flex: 1, padding: '8px 12px', fontSize: 10 }}
                    >
                      Start this video
                    </button>
                    <button
                      onClick={() => setRefiningIndex(refiningIndex === i ? null : i)}
                      style={{ ...btnGhost, padding: '8px 12px', fontSize: 10 }}
                    >
                      Refine
                    </button>
                    <button
                      onClick={() => dismissSuggestion(s)}
                      title="Not interested"
                      style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder, padding: '8px 12px', fontSize: 10 }}
                    >
                      ✕ Not interested
                    </button>
                  </div>

                  {refiningIndex === i && (
                    <div style={{ marginTop: 4, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                      <textarea
                        value={refineText}
                        onChange={(e) => setRefineText(e.target.value)}
                        placeholder='e.g. "more focused on the 90s"'
                        rows={2}
                        style={{ ...inputStyle, fontSize: 12, resize: 'vertical' }}
                        autoFocus
                      />
                      <div style={{ ...mono, fontSize: 10, color: T.textMuted, marginTop: 4 }}>
                        Relaunches the whole suggestion list oriented to this note.
                      </div>
                      <button
                        onClick={() => fetchSuggestions(refineText)}
                        disabled={suggestionsLoading || !refineText.trim()}
                        style={{ ...btnPrimary, marginTop: 6, padding: '8px 12px', fontSize: 10, opacity: refineText.trim() ? 1 : 0.6 }}
                      >
                        Regenerate with this note
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {awaitingReplacement && (
                <div
                  style={{
                    border: `1px dashed ${T.border}`,
                    borderRadius: 4,
                    padding: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 90,
                    ...mono,
                    fontSize: 11,
                    color: T.textMuted,
                  }}
                >
                  Finding a replacement idea…
                </div>
              )}
            </div>
          </div>
        )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => setVideoGridOpen((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
          }}
        >
          <span style={label}>Videos ({gridVideos.length})</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {videoGridOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>
        <button onClick={onNewVideo} style={btnGhost}>
          + New video
        </button>
      </div>

      {videoGridOpen && (gridVideos.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>No videos yet</div>
          <div style={{ fontFamily: FONT.ui, fontSize: 13, color: T.textSecondary, marginBottom: 20 }}>
            Start your first video for this channel and it'll show up here automatically, saved on this device.
          </div>
          <button onClick={onNewVideo} style={btnPrimary}>
            + New video
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {gridVideos.map((v) => {
            const isArchived = !!v.mediaArchived;
            const sceneCount = isArchived ? v.archivedSceneCount || 0 : v.scenes?.length || 0;
            const readyCount = isArchived
              ? sceneCount
              : v.scenes?.filter((s) => s.images?.every((im) => im.status === 'ready') && s.audioStatus === 'ready').length || 0;
            const title = v.displayTitle || 'Untitled video';
            const isPublished = !!v.youtubeVideoId;
            return (
              <div
                key={v.id}
                style={{
                  ...card,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  ...(isPublished ? { borderLeft: `4px solid ${T.green}` } : {}),
                }}
              >
                <div
                  style={{
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
                  {thumbUrls[v.id] ? (
                    <img src={thumbUrls[v.id]} alt={title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, textTransform: 'uppercase' }}>No preview</span>
                  )}
                </div>
                {isPublished && (
                  <a
                    href={`https://youtube.com/watch?v=${v.youtubeVideoId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      alignSelf: 'flex-start',
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: FONT.ui,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: T.green,
                      textDecoration: 'none',
                    }}
                  >
                    ▶ Published
                  </a>
                )}
                <div style={{ fontFamily: FONT.ui, fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{title}</div>
                <div style={{ ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span>
                    {isArchived
                      ? `${sceneCount} scene${sceneCount === 1 ? '' : 's'} · media archived`
                      : `${sceneCount} scene${sceneCount === 1 ? '' : 's'} · ${readyCount}/${sceneCount} ready`}
                  </span>
                  <span>created {formatDateTime(v.createdAt)}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
                  <button
                    onClick={() => onResume(v)}
                    title={isArchived ? 'Media archived after publish — opens a notice, not the editor' : undefined}
                    style={{ ...(isArchived ? btnGhost : btnPrimary), flex: '1 1 80px' }}
                  >
                    {isArchived ? 'Archived' : 'Resume'}
                  </button>
                  <button
                    onClick={() => (moveOpenForId === v.id ? closeMove() : openMoveFor(v))}
                    title="Move to another channel"
                    style={{ ...btnGhost, padding: '10px 12px', flexShrink: 0 }}
                  >
                    ⇄
                  </button>
                  {(() => {
                    // Extensible action menu behind the ⚙ — add an entry here, nothing else changes.
                    const cardMenuItems = [
                      { key: 'yt-status', label: '✏️ Edit YouTube status', onSelect: () => openYtEdit(v) },
                      { key: 'delete', label: '🗑 Delete', danger: true, onSelect: () => handleDeleteVideo(v.id) },
                    ];
                    const menuOpen = cardMenuOpenFor === v.id;
                    return (
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                          onClick={() => setCardMenuOpenFor((cur) => (cur === v.id ? null : v.id))}
                          title="More actions"
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          style={{ ...btnGhost, padding: '10px 12px' }}
                        >
                          ⚙
                        </button>
                        {menuOpen && (
                          <>
                            <div
                              onClick={() => setCardMenuOpenFor(null)}
                              style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                            />
                            <div
                              role="menu"
                              style={{
                                position: 'absolute',
                                top: 'calc(100% + 4px)',
                                right: 0,
                                zIndex: 41,
                                minWidth: 190,
                                background: T.bg,
                                border: `1px solid ${T.border}`,
                                borderRadius: 6,
                                boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
                                padding: 4,
                                display: 'flex',
                                flexDirection: 'column',
                              }}
                            >
                              {cardMenuItems.map((item) => (
                                <button
                                  key={item.key}
                                  role="menuitem"
                                  onClick={() => {
                                    setCardMenuOpenFor(null);
                                    item.onSelect();
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    textAlign: 'left',
                                    padding: '8px 10px',
                                    fontSize: 12,
                                    fontFamily: FONT.ui,
                                    color: item.danger ? T.primary : T.text,
                                    cursor: 'pointer',
                                    borderRadius: 4,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {item.label}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Companion Short — for every published video: view/link if it has one, generate it on
                    demand if it doesn't (or its record was deleted). Collapsed by default (just a
                    one-line status); expands to a compact horizontal row of actions. */}
                {isPublished &&
                  (() => {
                    const short = v.shortVideoId ? shortsById.get(v.shortVideoId) : null;
                    const busy = generatingShortFor === v.id;
                    const shortPublished = !!short?.youtubeVideoId;
                    const shortProduced = !shortPublished && !!short?.thumbnailStoragePath;
                    const generating = busy || (short && !shortPublished && !shortProduced);
                    const open = shortSectionOpenFor === v.id;
                    const ytUrl = short?.youtubeVideoId ? `https://youtube.com/watch?v=${short.youtubeVideoId}` : null;
                    const statusLabel = generating
                      ? '🎬 Short: Generating…'
                      : shortPublished
                      ? '🎬 Short: Published'
                      : shortProduced
                      ? '🎬 Short: Ready, not published'
                      : '🎬 No Short yet';
                    const greenLink = {
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: FONT.ui,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: T.green,
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    };
                    return (
                      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {/* Collapsed header: status on the left, SHOW/CLOSE on the right. */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <button
                              onClick={() => setShortSectionOpenFor((cur) => (cur === v.id ? null : v.id))}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                            >
                              <span style={{ fontSize: 11, fontFamily: FONT.ui, color: T.textSecondary }}>{statusLabel}</span>
                            </button>
                            {!open && ytUrl && (
                              <a href={ytUrl} target="_blank" rel="noreferrer" style={greenLink}>
                                ▶
                              </a>
                            )}
                          </div>
                          <button
                            onClick={() => setShortSectionOpenFor((cur) => (cur === v.id ? null : v.id))}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                          >
                            <span style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
                              {open ? 'CLOSE ▲' : 'SHOW ▼'}
                            </span>
                          </button>
                        </div>

                        {open && (
                          <>
                            {generating ? (
                              <span style={{ fontSize: 11, fontFamily: FONT.ui, color: T.textSecondary }}>⏳ Short generating…</span>
                            ) : short ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                {/* The Short's OWN thumbnail (vertical 9:16 — see thumbnailEngine.js), keyed by
                                    the Short's id in thumbUrls, never the parent's. */}
                                {thumbUrls[short.id] && (
                                  <img
                                    src={thumbUrls[short.id]}
                                    alt=""
                                    style={{
                                      width: 40,
                                      height: 70,
                                      objectFit: 'cover',
                                      borderRadius: 3,
                                      border: `1px solid ${T.border}`,
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <button onClick={() => onResume(short)} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                                  🎬 View Short
                                </button>
                                {shortPublished ? (
                                  <a href={ytUrl} target="_blank" rel="noreferrer" style={greenLink}>
                                    ▶ Short on YouTube
                                  </a>
                                ) : (
                                  <span style={{ fontSize: 10, fontFamily: FONT.ui, color: T.textMuted }}>◻ produced, not on YouTube yet</span>
                                )}
                              </div>
                            ) : null}

                            {/* Actions — separate row below. */}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {!short && !generating && (
                                <button
                                  onClick={() => setShortPublishChoiceFor(v.id)}
                                  disabled={!!generatingShortFor}
                                  style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: generatingShortFor ? 0.6 : 1 }}
                                >
                                  🎬 Generate Short
                                </button>
                              )}
                              {!generating && (
                                <button
                                  onClick={() => (linkShortForId === v.id ? closeLinkShort() : openLinkShortFor(v))}
                                  disabled={!!linkingShortId}
                                  style={{ ...btnGhost, padding: '6px 10px', fontSize: 10, opacity: linkingShortId ? 0.6 : 1 }}
                                >
                                  🔗 Link as Short
                                </button>
                              )}
                            </div>

                            {linkShortForId === v.id &&
                              (() => {
                                const candidates = (videos || []).filter((x) => x.id !== v.id);
                                return (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
                                    {candidates.length === 0 ? (
                                      <div style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui }}>
                                        No other video on this channel to link.
                                      </div>
                                    ) : (
                                      <>
                                        <div style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, lineHeight: 1.5 }}>
                                          Pick an existing video to attach as this video&apos;s companion Short.
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                          <select
                                            value={selectedLinkShortId}
                                            onChange={(e) => setSelectedLinkShortId(e.target.value)}
                                            style={{ ...inputStyle, flex: 1, minWidth: 130, fontSize: 11, padding: '6px 8px' }}
                                          >
                                            {candidates.map((c) => (
                                              <option key={c.id} value={c.id}>
                                                {(c.displayTitle || c.topic || 'Untitled video') + (c.isShort ? ' — currently a Short' : '')}
                                              </option>
                                            ))}
                                          </select>
                                          <button
                                            onClick={() => confirmLinkShort(v)}
                                            disabled={linkingShortId === v.id || !selectedLinkShortId}
                                            style={{ ...btnPrimary, padding: '6px 10px', fontSize: 10, opacity: linkingShortId === v.id ? 0.6 : 1 }}
                                          >
                                            {linkingShortId === v.id ? '…' : 'Link'}
                                          </button>
                                          <button
                                            onClick={closeLinkShort}
                                            disabled={linkingShortId === v.id}
                                            style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </>
                                    )}
                                    {linkShortError && (
                                      <div style={{ fontSize: 10, color: T.primary, fontFamily: FONT.ui }}>{linkShortError}</div>
                                    )}
                                  </div>
                                );
                              })()}
                          </>
                        )}
                      </div>
                    );
                  })()}

                {ytEditOpenForId === v.id && (
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {isPublished ? (
                      <>
                        <a
                          href={`https://youtube.com/watch?v=${v.youtubeVideoId}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 11, fontFamily: FONT.ui, color: T.primary, wordBreak: 'break-all' }}
                        >
                          youtube.com/watch?v={v.youtubeVideoId}
                        </a>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => markAsNotPublished(v)}
                            disabled={ytEditBusy === v.id}
                            style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder, padding: '6px 10px', fontSize: 10, flex: 1 }}
                          >
                            {ytEditBusy === v.id ? '…' : 'Mark as NOT published'}
                          </button>
                          <button onClick={closeYtEdit} disabled={ytEditBusy === v.id} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                            Cancel
                          </button>
                        </div>
                        <div style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, lineHeight: 1.5 }}>
                          Use this only if the video was removed from YouTube — this re-enables full upload for this video.
                        </div>
                      </>
                    ) : (
                      <>
                        <input
                          value={ytIdInput}
                          onChange={(e) => setYtIdInput(e.target.value)}
                          placeholder="YouTube video ID or URL"
                          style={{ ...inputStyle, fontSize: 11, padding: '6px 8px' }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => markAsPublished(v)}
                            disabled={ytEditBusy === v.id}
                            style={{ ...btnPrimary, padding: '6px 10px', fontSize: 10, flex: 1, opacity: ytEditBusy === v.id ? 0.6 : 1 }}
                          >
                            {ytEditBusy === v.id ? '…' : 'Mark as published'}
                          </button>
                          <button onClick={closeYtEdit} disabled={ytEditBusy === v.id} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                            Cancel
                          </button>
                        </div>
                        <div style={{ fontSize: 10, color: T.textMuted, fontFamily: FONT.ui, lineHeight: 1.5 }}>
                          Use this if the video was uploaded to YouTube outside of WisiTube.
                        </div>
                      </>
                    )}
                    {ytEditError && <div style={{ fontSize: 10, color: T.primary, fontFamily: FONT.ui }}>{ytEditError}</div>}
                  </div>
                )}

                {moveOpenForId === v.id && (
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                    {moveChannelsLoading ? (
                      <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>Loading channels…</div>
                    ) : moveChannels.length === 0 ? (
                      <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui }}>No other channels to move this video to.</div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <select
                          value={selectedMoveChannelId}
                          onChange={(e) => setSelectedMoveChannelId(e.target.value)}
                          style={{ ...inputStyle, flex: 1, minWidth: 110, fontSize: 11, padding: '6px 8px' }}
                        >
                          {moveChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name || 'Untitled channel'}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => confirmMoveVideo(v)}
                          disabled={movingId === v.id}
                          style={{ ...btnPrimary, padding: '6px 10px', fontSize: 10, opacity: movingId === v.id ? 0.6 : 1 }}
                        >
                          {movingId === v.id ? '…' : 'Move'}
                        </button>
                        <button onClick={closeMove} disabled={movingId === v.id} style={{ ...btnGhost, padding: '6px 10px', fontSize: 10 }}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {moveError && <div style={{ marginTop: 6, fontSize: 10, color: T.primary, fontFamily: FONT.ui }}>{moveError}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {shortPublishChoiceFor &&
        (() => {
          const choiceVideo = (videos || []).find((x) => x.id === shortPublishChoiceFor);
          if (!choiceVideo) return null;
          return (
            <div
              onClick={() => setShortPublishChoiceFor(null)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 2000,
                background: 'rgba(0,0,0,0.5)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 20,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ ...card, width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 700, color: T.text }}>Generate companion Short</div>
                <div style={{ fontFamily: FONT.ui, fontSize: 12, color: T.textSecondary, lineHeight: 1.5 }}>
                  “{choiceVideo.displayTitle || choiceVideo.topic}” — how should the Short be published once it’s produced?
                </div>
                <button
                  onClick={() => handleGenerateShort(choiceVideo, { autoPublish: true })}
                  disabled={!!generatingShortFor}
                  style={{ ...btnPrimary, padding: '10px 12px', fontSize: 12 }}
                >
                  Generate and publish automatically
                </button>
                <button
                  onClick={() => handleGenerateShort(choiceVideo, { autoPublish: false })}
                  disabled={!!generatingShortFor}
                  style={{ ...btnGhost, padding: '10px 12px', fontSize: 12 }}
                >
                  Generate only, I&apos;ll publish it manually
                </button>
                <button
                  onClick={() => setShortPublishChoiceFor(null)}
                  style={{ ...btnGhost, padding: '8px 12px', fontSize: 11, border: 'none', color: T.textMuted }}
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        })()}

      {showProgramManagerChat && (
        <ProgramManagerChat
          channel={channel}
          videos={videos}
          onApplyUpdate={(text) => savePromptOverride('programManager', text)}
          onSaveChat={saveProgramManagerChat}
          onClose={() => setShowProgramManagerChat(false)}
        />
      )}
    </div>
  );
}
