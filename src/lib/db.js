// Local persistence — IndexedDB via idb-keyval, so raw media Blobs (images, voiceover) survive a
// refresh or browser restart with no size limits. Two stores: channels (containers) and videos
// (the per-video projects that used to be the only level — each now tagged with a channelId).
import { get, set, del, entries, createStore } from 'idb-keyval';

const videoStore = createStore('wisitube-db', 'projects');
// Deliberately a separate IndexedDB database, not another store in 'wisitube-db': idb-keyval's
// createStore() opens its database with no explicit version, so onupgradeneeded (which is what
// actually creates an object store) only ever fires the first time a given dbName is opened.
// Two createStore() calls sharing 'wisitube-db' would race — whichever store's first read/write
// happens second would find its object store was never created and throw NotFoundError, for
// every user (new or existing). A dedicated database for channels sidesteps that entirely.
const channelStore = createStore('wisitube-channels-db', 'channels');
// Same reasoning as channelStore above: its own dedicated database, not another store bolted onto
// an existing one, so the first read/write against it can't race a sibling store's first-ever
// onupgradeneeded and throw NotFoundError.
const costLedgerStore = createStore('wisitube-cost-ledger-db', 'costLedger');

const MIGRATION_FLAG = 'wisitube_migrated_channels';

export function createId() {
  return crypto.randomUUID();
}

// ---- Videos (the single-level "project" this store used to hold) ----

export async function saveVideo(video) {
  const toSave = { ...video, updatedAt: Date.now() };
  await set(toSave.id, toSave, videoStore);
  return toSave;
}

export function loadVideo(id) {
  return get(id, videoStore);
}

export async function listVideos() {
  const all = await entries(videoStore);
  return all.map(([, value]) => value).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function listVideosByChannel(channelId) {
  const all = await listVideos();
  return all.filter((v) => v.channelId === channelId);
}

export function deleteVideo(id) {
  return del(id, videoStore);
}

// ---- Channels ----

export async function saveChannel(channel) {
  const toSave = { ...channel, updatedAt: Date.now() };
  await set(toSave.id, toSave, channelStore);
  return toSave;
}

export function loadChannel(id) {
  return get(id, channelStore);
}

export async function listChannels() {
  await migrateOrphanVideosOnce();
  const all = await entries(channelStore);
  return all.map(([, value]) => value).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteChannel(id) {
  const videos = await listVideosByChannel(id);
  await Promise.all(videos.map((v) => deleteVideo(v.id)));
  await del(id, channelStore);
}

// ---- YouTube per-channel connection (see api/youtube-callback.js, which is the only source of
// this data — there's no server-side storage, so the refresh token round-trips through the OAuth
// redirect's query string and lands here on the client). ----

export async function saveYoutubeConnection(channelId, data) {
  const channel = await loadChannel(channelId);
  if (!channel) return null;
  return saveChannel({
    ...channel,
    youtube: {
      connected: true,
      channelName: data.channelName || '',
      youtubeChannelId: data.youtubeChannelId || '',
      refreshToken: data.refreshToken || '',
    },
  });
}

export async function clearYoutubeConnection(channelId) {
  const channel = await loadChannel(channelId);
  if (!channel) return null;
  return saveChannel({ ...channel, youtube: { connected: false, channelName: '', youtubeChannelId: '', refreshToken: '' } });
}

// ---- Cost ledger — persistent record of real money actually spent (never an estimate), append-
// only: an entry, once written, is never edited or removed, so the numbers here can always be
// trusted as "what really happened" rather than a projection. One entry per successful paid call
// (image via nanobanana/gptimage, audio via MiniMax) — see the recordCost call sites in
// StoryboardStep.jsx and ExportStep.jsx for exactly what counts. ----

export async function recordCost({ channelId, videoId, provider, type, amountUsd, timestamp }) {
  const entry = {
    id: createId(),
    channelId,
    videoId: videoId || null,
    provider,
    type, // 'image' | 'audio'
    amountUsd,
    timestamp: timestamp || Date.now(),
  };
  await set(entry.id, entry, costLedgerStore);
  return entry;
}

export async function getCostsByChannel(channelId) {
  const all = await entries(costLedgerStore);
  const items = all
    .map(([, v]) => v)
    .filter((e) => e.channelId === channelId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const total = items.reduce((sum, e) => sum + (e.amountUsd || 0), 0);
  return { total, items };
}

export async function getTotalCostAllChannels() {
  const all = await entries(costLedgerStore);
  return all.reduce((sum, [, v]) => sum + (v.amountUsd || 0), 0);
}

// ---- One-time migration: videos saved before Channels existed have no channelId. Runs lazily
// the first time channels are listed (app startup), guarded by a localStorage flag so it only
// ever does real work once — no video is deleted or overwritten, only tagged with a channelId.
async function migrateOrphanVideosOnce() {
  let alreadyMigrated = false;
  try {
    alreadyMigrated = !!localStorage.getItem(MIGRATION_FLAG);
  } catch {
    alreadyMigrated = true; // no localStorage available — don't retry every call
  }
  if (alreadyMigrated) return;

  const all = await listVideos();
  const orphans = all.filter((v) => !v.channelId);
  if (orphans.length > 0) {
    const channel = await saveChannel({
      id: createId(),
      name: 'My first channel',
      niche: '',
      editorialNotes: '',
      createdAt: Date.now(),
    });
    await Promise.all(orphans.map((v) => saveVideo({ ...v, channelId: channel.id })));
  }
  try {
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch {
    /* ignore */
  }
}
