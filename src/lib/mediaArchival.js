// Storage housekeeping: once a video has been live on YouTube for a while, its heavy generation
// media (scene images, scene audio, the rendered MP4, static background, reference photos) is dead
// weight — the video exists on YouTube, and nothing in this app reads that media back for a
// published video. This module deletes those files from Supabase Storage and replaces the video's
// `project` jsonb with a light stub, keeping only what's still read after publish:
//
//   - Content Program Manager  -> subject (+ description/tags/series/outline kept as cheap text
//                                 even though only `subject` is currently read — see the
//                                 investigation notes in the PR that added this)
//   - dashboard grid           -> youtubeVideoId (published badge), thumbnailStoragePath (preview),
//                                 titles/selectedTitle (title), archivedSceneCount (the "N scenes"
//                                 line, since project.scenes is gone)
//   - resume/automation guards -> youtubeVideoId / youtubeUploadStarted (determineResumePhase and
//                                 findResumableVideo both short-circuit on these)
//
// promised_follow_up / promise_fulfilled are top-level columns (not in project jsonb), so
// listPendingPromises keeps working untouched. The 'thumbnail' storage folder is deliberately never
// deleted — the dashboard preview points at it.
//
// A video whose media has been archived can't be opened in Storyboard/Editor/Export — App.jsx's
// handleResume detects project.mediaArchived and shows a "go watch it on YouTube" notice instead of
// feeding an empty scenes array into the editor.
import { listChannels, listVideosByChannel, loadVideo, saveVideo, logAutomationStep } from './db';
import { listVideoMediaFiles, removeMediaFiles, ARCHIVABLE_MEDIA_KINDS } from './mediaStorage';

export const ARCHIVE_AFTER_DAYS = 5;
const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// When was this video published? youtubePublishedAt is stamped at publish time going forward; for
// videos published before that field existed, fall back to updatedAt (best effort — a published
// video is rarely edited after, so updatedAt ~= publish time).
export function publishedAtOf(video) {
  return Number(video?.youtubePublishedAt) || Number(video?.updatedAt) || Number(video?.createdAt) || 0;
}

// The light stub that replaces `project` for an archived video. Built from the full record
// (fromVideoRow spreads project fields onto the record, so record.subject etc. are all here).
export function buildArchivedProject(record) {
  return {
    // title still comes from here (dashboard grid, breadcrumb)
    titles: Array.isArray(record.titles) ? record.titles : [],
    selectedTitle: Number(record.selectedTitle) || 0,
    // Content Program Manager anti-repetition + cheap-to-keep metadata
    subject: record.subject || null,
    series: record.series || null,
    description: record.description || '',
    tags: Array.isArray(record.tags) ? record.tags : [],
    outline: Array.isArray(record.outline) ? record.outline : [],
    // published / resume-guard state
    youtubeVideoId: record.youtubeVideoId || null,
    youtubeUploadStarted: record.youtubeUploadStarted === true,
    youtubePublishedAt: Number(record.youtubePublishedAt) || null,
    thumbnailPublishFailed: record.thumbnailPublishFailed === true,
    createdByAutomation: record.createdByAutomation === true,
    subtitles: !!record.subtitles,
    // dashboard preview
    thumbnailStoragePath: record.thumbnailStoragePath || null,
    // replaces the now-gone project.scenes for the "N scenes" line
    archivedSceneCount: Array.isArray(record.scenes)
      ? record.scenes.length
      : Number(record.totalScenes) || 0,
    // the archive markers themselves
    mediaArchived: true,
    mediaArchivedAt: Date.now(),
  };
}

// Every published, not-yet-archived video across all of this user's channels that's been live at
// least ARCHIVE_AFTER_DAYS. Returns full records (with channelName attached).
export async function findArchivableVideos() {
  const cutoff = Date.now() - ARCHIVE_AFTER_MS;
  const channels = await listChannels();
  const out = [];
  for (const channel of channels) {
    // eslint-disable-next-line no-await-in-loop
    const videos = await listVideosByChannel(channel.id);
    for (const v of videos) {
      if (!v.youtubeVideoId) continue; // never published
      if (v.mediaArchived) continue; // already done
      if (publishedAtOf(v) > cutoff) continue; // published too recently
      out.push({ ...v, channelName: channel.name || 'Untitled channel' });
    }
  }
  return out;
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
};

/**
 * Dry-run: what WOULD be cleaned up, without touching anything.
 * Returns { videos: [{ videoId, channelName, displayTitle, publishedAt, fileCount, bytes }],
 *           totalVideos, totalFiles, totalBytes, totalBytesLabel }.
 */
export async function planMediaCleanup(userId) {
  if (!userId) throw new Error('planMediaCleanup: userId is required (storage paths are per-user)');
  const candidates = await findArchivableVideos();
  const videos = [];
  let totalFiles = 0;
  let totalBytes = 0;
  for (const v of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const files = await listVideoMediaFiles(userId, v.id, ARCHIVABLE_MEDIA_KINDS);
    const bytes = files.reduce((a, f) => a + f.size, 0);
    totalFiles += files.length;
    totalBytes += bytes;
    videos.push({
      videoId: v.id,
      channelName: v.channelName,
      displayTitle: v.displayTitle || v.topic || 'Untitled video',
      publishedAt: publishedAtOf(v),
      fileCount: files.length,
      bytes,
    });
  }
  return {
    videos,
    totalVideos: videos.length,
    totalFiles,
    totalBytes,
    totalBytesLabel: fmtBytes(totalBytes),
  };
}

/**
 * The real thing. For each eligible video: delete its heavy media from Storage, then replace its
 * project jsonb with buildArchivedProject() and mark mediaArchived: true. Per-video failures are
 * isolated (logged, counted, skipped) so one bad video never blocks the rest.
 *
 * dryRun: true  -> identical to planMediaCleanup (nothing deleted).
 * onProgress({ done, total, videoTitle }): optional, fired after each video.
 *
 * Returns { dryRun, archived, failed, freedBytes, freedBytesLabel, plan } — `plan` is the
 * planMediaCleanup result so a caller can show the before-picture regardless of dryRun.
 */
export async function runMediaCleanup(userId, { dryRun = true, onProgress, log = false } = {}) {
  if (!userId) throw new Error('runMediaCleanup: userId is required (storage paths are per-user)');
  const plan = await planMediaCleanup(userId);

  if (dryRun) {
    return {
      dryRun: true,
      archived: 0,
      failed: 0,
      freedBytes: 0,
      freedBytesLabel: '0 B',
      plan,
    };
  }

  let archived = 0;
  let failed = 0;
  let freedBytes = 0;
  const total = plan.videos.length;

  for (let i = 0; i < plan.videos.length; i++) {
    const entry = plan.videos[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const files = await listVideoMediaFiles(userId, entry.videoId, ARCHIVABLE_MEDIA_KINDS);
      // eslint-disable-next-line no-await-in-loop
      await removeMediaFiles(files.map((f) => f.path));

      // Re-load fresh right before the write — the plan may be a few seconds/minutes old and the
      // video could have been touched in between; saveVideo is a full-row upsert so we want the
      // current top-level columns (topic, settings, displayTitle, promise fields).
      // eslint-disable-next-line no-await-in-loop
      const fresh = await loadVideo(entry.videoId);
      if (!fresh) throw new Error('video no longer exists');
      if (fresh.mediaArchived) {
        // Another run (or the daily hook) got here first — files are already gone, nothing to do.
        archived++;
        freedBytes += files.reduce((a, f) => a + f.size, 0);
        onProgress?.({ done: i + 1, total, videoTitle: entry.displayTitle });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await saveVideo({
        id: fresh.id,
        channelId: fresh.channelId,
        createdAt: fresh.createdAt,
        topic: fresh.topic,
        settings: fresh.settings,
        displayTitle: fresh.displayTitle,
        promisedFollowUp: fresh.promisedFollowUp,
        promiseFulfilled: fresh.promiseFulfilled,
        ...buildArchivedProject(fresh),
      });

      archived++;
      freedBytes += files.reduce((a, f) => a + f.size, 0);
      if (log) {
        // eslint-disable-next-line no-await-in-loop
        await logAutomationStep(
          fresh.channelId,
          fresh.id,
          'cleanup',
          'success',
          `archived media for "${entry.displayTitle}" — removed ${files.length} file(s), freed ${fmtBytes(files.reduce((a, f) => a + f.size, 0))}`
        ).catch(() => {});
      }
    } catch (err) {
      failed++;
      console.error('[mediaArchival] failed to archive video', entry.videoId, err);
      if (log) {
        // eslint-disable-next-line no-await-in-loop
        await logAutomationStep(null, entry.videoId, 'cleanup', 'error', `could not archive "${entry.displayTitle}": ${String(err?.message || err)}`).catch(
          () => {}
        );
      }
    }
    onProgress?.({ done: i + 1, total, videoTitle: entry.displayTitle });
  }

  return {
    dryRun: false,
    archived,
    failed,
    freedBytes,
    freedBytesLabel: fmtBytes(freedBytes),
    plan,
  };
}
