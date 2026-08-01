import React, { useEffect, useState } from 'react';
import { T, FONT, card, label, btnPrimary, btnGhost, inputStyle, mono } from '../theme';
import {
  listVideosByChannel,
  deleteVideo,
  saveVideo,
  loadChannel,
  listChannels,
  saveChannel,
  deleteChannel,
  clearYoutubeConnection,
  getCostsByChannel,
  savePromptVersion,
  listPromptVersions,
  recordCost,
} from '../lib/db';
import { getMediaUrl, uploadMedia } from '../lib/mediaStorage';
import { listChannelPlaylists } from '../lib/youtubePublishEngine';
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

export default function ChannelDashboardStep({ channelId, userId, onResume, onNewVideo, onBack, onChannelChange, onStartVideoFromSuggestion, isMobile }) {
  const [channel, setChannel] = useState(null);
  const [name, setName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [niche, setNiche] = useState('');
  const [notes, setNotes] = useState('');
  const [videos, setVideos] = useState(null); // null = still loading
  const [thumbUrls, setThumbUrls] = useState({});
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
  // Local in-progress edits per stage, keyed by stage — undefined means "not yet touched this
  // session, fall back to channel.prompt_overrides[stage] or the stage's default text". Kept
  // separate from channel state so typing doesn't need a round-trip through saveChannel on every
  // keystroke; onBlur is what persists.
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
  // "Edit YouTube status" — id of the video card whose popover is open (null = none), mutually
  // exclusive with the "move" popover above (opening one closes the other, see openYtEdit/
  // openMoveFor) so a single card never shows two overlapping inline panels at once.
  const [ytEditOpenForId, setYtEditOpenForId] = useState(null);
  const [ytIdInput, setYtIdInput] = useState('');
  const [ytEditBusy, setYtEditBusy] = useState(null); // videoId currently being saved, or null
  const [ytEditError, setYtEditError] = useState('');

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
      setVideos(list);
      setTotalSpent(costs.total);
      // Phase 3: the Blob itself never survives a reload (see stripBlobsForSync, src/lib/db.js) —
      // storagePath is the Supabase Storage backup, sign a short-lived URL to preview it. Videos
      // that never reached image generation (or whose backup failed) have no storagePath, and
      // keep the "No preview" placeholder.
      const urls = {};
      for (const v of list) {
        const storagePath = v.scenes?.[0]?.images?.[0]?.storagePath;
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
    const updated = await saveChannel({ ...channel, name: trimmed });
    setChannel(updated);
    setName(updated.name || '');
    onChannelChange?.(updated);
  }

  async function saveNiche() {
    if (!channel || niche === (channel.niche || '')) return;
    const updated = await saveChannel({ ...channel, niche });
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function saveNotes() {
    if (!channel || notes === (channel.editorialNotes || '')) return;
    const updated = await saveChannel({ ...channel, editorialNotes: notes });
    setChannel(updated);
    onChannelChange?.(updated);
  }

  async function saveContentType(value) {
    if (!channel) return;
    const updated = await saveChannel({ ...channel, content_type: value });
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
      saveChannel({ ...channel, prompt_overrides: nextOverrides }),
      // Only real custom content is worth a version entry — reverting to the default (or clearing)
      // isn't a "version" of anything, and savePromptVersion no-ops on an empty string anyway.
      effectiveNext ? savePromptVersion(channel.id, stage, effectiveNext) : Promise.resolve(null),
    ]);
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

  // Refining never edits a single suggestion — it relaunches the whole holistic pass with the
  // extra instruction folded in, replacing the entire list at once.
  async function fetchSuggestions(refinementText) {
    if (!channel) return;
    setSuggestionsLoading(true);
    setSuggestionsError('');
    try {
      // Enrichment, not a required step — listChannelPlaylists already swallows its own failures
      // and returns [] rather than throwing, so this never blocks getting suggestions.
      const existingPlaylists = await listChannelPlaylists(channel);
      const res = await fetch('/api/program-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: channel.name,
          niche: channel.niche || '',
          editorialNotes: channel.editorialNotes || '',
          existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
          refinement: refinementText || '',
          creativeOverride: channel.prompt_overrides?.programManager || null,
          existingPlaylists,
          // A full regeneration must not resurface ideas already explicitly dismissed as
          // "not interested" (see dismissSuggestion below).
          avoidTitles: channel.dismissed_suggestions || [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate suggestions');
      const lastSuggestions = { analysis: data.analysis || '', suggestions: data.suggestions || [], generatedAt: Date.now() };
      const updated = await saveChannel({ ...channel, lastSuggestions });
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

  // Fetches exactly one replacement suggestion and appends it to whatever's currently on the list
  // (simpler and just as correct as reinserting at the original slot, since by the time this
  // resolves other suggestions may have been started/dismissed too, making "the original slot"
  // ambiguous). baseChannel is the freshest known channel object at the moment this was kicked off
  // (see startSuggestion) — used to build avoidTitles, not re-read from the (possibly stale) closure.
  async function replaceSuggestionInBackground(baseChannel) {
    setAwaitingReplacement(true);
    try {
      const existingPlaylists = await listChannelPlaylists(baseChannel);
      const remainingTitles = (baseChannel.lastSuggestions?.suggestions || []).map((s) => s.title).filter(Boolean);
      const existingVideoTitles = (videos || []).map((v) => v.displayTitle || v.topic || '').filter(Boolean);
      const avoidTitles = [...remainingTitles, ...existingVideoTitles, ...(baseChannel.dismissed_suggestions || [])];
      const res = await fetch('/api/program-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: baseChannel.name,
          niche: baseChannel.niche || '',
          editorialNotes: baseChannel.editorialNotes || '',
          existingVideos: (videos || []).map((v) => ({ title: v.displayTitle || '', topic: v.topic || '' })),
          refinement: '',
          creativeOverride: baseChannel.prompt_overrides?.programManager || null,
          existingPlaylists,
          count: 1,
          avoidTitles,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch a replacement suggestion');
      const newSuggestion = (data.suggestions || [])[0];
      if (!newSuggestion) return;

      // Functional update to read the truly-latest channel state (something else may have changed
      // it while this fetch was in flight, e.g. another suggestion started or dismissed) — captured
      // into a local var so the subsequent saveChannel call has the exact object just applied.
      let latestChannel;
      setChannel((prev) => {
        if (!prev) return prev;
        const suggestions = [...(prev.lastSuggestions?.suggestions || []), newSuggestion];
        latestChannel = { ...prev, lastSuggestions: { ...prev.lastSuggestions, suggestions } };
        return latestChannel;
      });
      if (!latestChannel) return;
      const updated = await saveChannel(latestChannel);
      setChannel(updated);
      onChannelChange?.(updated);
    } catch (err) {
      console.error('[ChannelDashboardStep] failed to fetch/save a replacement suggestion', err);
    } finally {
      setAwaitingReplacement(false);
    }
  }

  // "Start this video" — removes the suggestion immediately (before the replacement round-trip
  // even begins) so the list never keeps showing an idea that's already being turned into a video,
  // even if the user navigates back here before the background replacement arrives.
  function startSuggestion(s, i) {
    onStartVideoFromSuggestion?.(s.title, s.series || null);
    let latestChannel;
    setChannel((prev) => {
      if (!prev) return prev;
      const remaining = (prev.lastSuggestions?.suggestions || []).filter((_, idx) => idx !== i);
      latestChannel = { ...prev, lastSuggestions: { ...prev.lastSuggestions, suggestions: remaining } };
      return latestChannel;
    });
    if (!latestChannel) return;
    saveChannel(latestChannel)
      .then((updated) => {
        setChannel(updated);
        onChannelChange?.(updated);
        replaceSuggestionInBackground(updated);
      })
      .catch((err) => console.error('[ChannelDashboardStep] failed to remove started suggestion', err));
  }

  // "Not interested" — removes the suggestion with no replacement (the list simply gets shorter)
  // and remembers the title so it never resurfaces in a future single replacement or full
  // regeneration (see avoidTitles above and in fetchSuggestions) — capped at the most recent 50.
  function dismissSuggestion(s, i) {
    let latestChannel;
    setChannel((prev) => {
      if (!prev) return prev;
      const remaining = (prev.lastSuggestions?.suggestions || []).filter((_, idx) => idx !== i);
      const dismissed = [...(prev.dismissed_suggestions || []), s.title].filter(Boolean).slice(-50);
      latestChannel = {
        ...prev,
        lastSuggestions: { ...prev.lastSuggestions, suggestions: remaining },
        dismissed_suggestions: dismissed,
      };
      return latestChannel;
    });
    if (!latestChannel) return;
    saveChannel(latestChannel)
      .then((updated) => {
        setChannel(updated);
        onChannelChange?.(updated);
      })
      .catch((err) => console.error('[ChannelDashboardStep] failed to save dismissed suggestion', err));
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

  // Instant-save for the simple defaults below (color pickers, outline toggle) — same
  // read-latest-then-save pattern as saveNiche/saveNotes above, just generalized to an arbitrary
  // patch since there are several independent fields here.
  async function updateStaticDefaults(patch) {
    if (!channel) return;
    try {
      const updated = await saveChannel({ ...channel, ...patch });
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
    if (!window.confirm('Delete this video? This cannot be undone.')) return;
    await deleteVideo(id);
    setVideos((list) => list.filter((v) => v.id !== id));
  }

  async function openMoveFor(v) {
    setYtEditOpenForId(null);
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
      setVideos(fresh);
      setMoveOpenForId(null);
    } catch (err) {
      setMoveError('Move failed: ' + String(err.message || err));
    } finally {
      setMovingId(null);
    }
  }

  function openYtEdit(v) {
    setMoveOpenForId(null);
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
      await saveVideo({ ...v, youtubeVideoId: id });
      const fresh = await listVideosByChannel(channelId);
      setVideos(fresh);
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
      setVideos(fresh);
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
            {channel?.lastSuggestions?.generatedAt && (
              <div style={{ ...mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>generated {timeAgo(channel.lastSuggestions.generatedAt)}</div>
            )}
          </div>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {programManagerOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>

        {programManagerOpen && (
          <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => fetchSuggestions('')} disabled={suggestionsLoading} style={{ ...btnPrimary, opacity: suggestionsLoading ? 0.6 : 1 }}>
            {suggestionsLoading ? 'Working…' : channel?.lastSuggestions ? 'Refresh suggestions' : 'Suggest next videos'}
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

        {channel?.lastSuggestions && !suggestionsLoading && (
          <div style={{ marginTop: 16 }}>
            {channel.lastSuggestions.analysis && (
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
                {channel.lastSuggestions.analysis}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {(channel.lastSuggestions.suggestions || []).map((s, i) => (
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

                  <div style={{ display: 'flex', gap: 6, marginTop: 'auto', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => startSuggestion(s, i)}
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
                      onClick={() => dismissSuggestion(s, i)}
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
          <span style={label}>Videos ({videos.length})</span>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, fontWeight: 700, textTransform: 'uppercase' }}>
            {videoGridOpen ? 'CLOSE ▲' : 'SHOW ▼'}
          </span>
        </button>
        <button onClick={onNewVideo} style={btnGhost}>
          + New video
        </button>
      </div>

      {videoGridOpen && (videos.length === 0 ? (
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
          {videos.map((v) => {
            const sceneCount = v.scenes?.length || 0;
            const readyCount = v.scenes?.filter((s) => s.images?.every((im) => im.status === 'ready') && s.audioStatus === 'ready').length || 0;
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
                <div style={{ ...mono, fontSize: 11, color: T.textSecondary, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    {sceneCount} scene{sceneCount === 1 ? '' : 's'} · {readyCount}/{sceneCount} ready
                  </span>
                  <span>{timeAgo(v.updatedAt)}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
                  <button onClick={() => onResume(v)} style={{ ...btnPrimary, flex: '1 1 80px' }}>
                    Resume
                  </button>
                  <button
                    onClick={() => (moveOpenForId === v.id ? closeMove() : openMoveFor(v))}
                    title="Move to another channel"
                    style={{ ...btnGhost, padding: '10px 12px', flexShrink: 0 }}
                  >
                    ⇄
                  </button>
                  <button
                    onClick={() => (ytEditOpenForId === v.id ? closeYtEdit() : openYtEdit(v))}
                    title="Edit YouTube status"
                    style={{ ...btnGhost, padding: '10px 12px', flexShrink: 0 }}
                  >
                    ⚙
                  </button>
                  <button
                    onClick={() => handleDeleteVideo(v.id)}
                    style={{ ...btnGhost, color: T.primary, borderColor: T.primaryBorder, padding: '10px 14px', flexShrink: 0 }}
                  >
                    Delete
                  </button>
                </div>

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
    </div>
  );
}
