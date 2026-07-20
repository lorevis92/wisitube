// YouTube publishing sequence — extracted verbatim from ExportStep.jsx's runUpload/runThumbnail/
// runCaptions/runPlaylist/publishToYoutube (pure refactor). No behavior change: same init-upload →
// byte upload (via the existing src/lib/youtubeUpload.js) → set-thumbnail → set-captions →
// add-to-playlist sequence, same error passthrough from api/youtube.js, same diagnostic logging.
//
// Every phase reports through `onProgress` rather than touching React state directly — same
// "no framework dependency" shape as mediaGenerationEngine.js. ExportStep.jsx's own
// runUpload/runThumbnail/runCaptions/runPlaylist wrappers translate each event into its existing
// setYtErrors/setYtUploadPct/setYtVideoId calls, so its own publishToYoutube()/retryPhase() —
// which orchestrate those wrappers — need no changes at all.
//
// onProgress event shapes:
//   { kind: 'upload-progress', percent }     — same shape as ExportStep's setYtUploadPct(percent)
//   { kind: 'video-id', videoId }            — same shape as ExportStep's setYtVideoId(videoId)
//   { kind: 'error', phase, message }        — same shape as setYtErrors(prev => ({...prev, [phase]: message}))
//   { kind: 'error-clear', phase }           — same shape as setYtErrors(prev => ({...prev, [phase]: null}))
// phase is one of 'upload' | 'thumbnail' | 'captions' | 'playlist', matching ExportStep's ytErrors keys.
import { uploadVideoToYoutube } from './youtubeUpload';
import { buildSrtFromScenes } from './srtBuilder';

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Uploads the rendered video and creates the YouTube video (private/scheduled/public per
 * metadata.privacyStatus/publishAt). Returns the new video id, or null on failure (the failure
 * itself is reported via onProgress, matching the original's "never throw to the caller" contract
 * — every phase is independently retryable from ExportStep.jsx).
 *
 * metadata: { title, description, tags, categoryId, language, privacyStatus, scheduleMode,
 * publishAt, madeForKids } — scheduleMode is 'now' | 'schedule', same as ExportStep's ytScheduleMode.
 */
export async function uploadVideo(project, videoBlob, { channel, metadata, onProgress } = {}) {
  console.log('[yt-upload] phase=runUpload:enter');
  onProgress?.({ kind: 'error-clear', phase: 'upload' });
  onProgress?.({ kind: 'upload-progress', percent: 0 });
  try {
    const refreshToken = channel?.youtube_refresh_token;
    if (!refreshToken) throw new Error('This channel is not connected to YouTube.');
    if (!videoBlob) throw new Error('Render the video first.');

    const publishAt = metadata.scheduleMode === 'schedule' && metadata.publishAt ? new Date(metadata.publishAt).toISOString() : null;

    console.log('[yt-upload] phase=init-upload:before', { channelId: channel?.id, publishAt });
    let initRes;
    try {
      initRes = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'init-upload',
          channelId: channel?.id,
          refreshToken,
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: metadata.categoryId,
          language: metadata.language,
          privacyStatus: metadata.privacyStatus,
          publishAt,
          madeForKids: metadata.madeForKids,
        }),
      });
    } catch (err) {
      console.error('[yt-upload] phase=init-upload:fetch-error', err?.message, err?.stack);
      throw err;
    }
    console.log('[yt-upload] phase=init-upload:after', { status: initRes.status, ok: initRes.ok });

    let initData;
    try {
      initData = await initRes.json();
    } catch (err) {
      console.error('[yt-upload] phase=init-upload:parse-json-error', err?.message, err?.stack);
      throw err;
    }
    // The exact uploadUrl string is the thing to check first when the PUT below fails before
    // ever reaching googleapis.com — undefined/malformed here means init-upload didn't return
    // what this code assumes it did.
    console.log('[yt-upload] phase=init-upload:data', {
      uploadUrl: initData.uploadUrl,
      uploadUrlType: typeof initData.uploadUrl,
      hasAccessToken: !!initData.accessToken,
    });
    if (!initRes.ok) {
      // error is a string for our own validation failures, but a boolean flag when it's a
      // passthrough of Google's response (see api/youtube.js init-upload) — the real message is
      // in detail (plus optionally reason) in that case.
      const message =
        typeof initData.error === 'string' && initData.error
          ? initData.error
          : `YouTube rejected the upload: ${initData.detail || 'Unknown error'}${initData.reason ? ` (${initData.reason})` : ''}`;
      throw new Error(message);
    }

    console.log('[yt-upload] phase=video-blob:resolved', { size: videoBlob.size, type: videoBlob.type });

    console.log('[yt-upload] phase=upload-video-to-youtube:before', {
      uploadUrl: initData.uploadUrl,
      blobSize: videoBlob.size,
      hasAccessToken: !!initData.accessToken,
      hasProgressCallback: true,
    });
    let videoId;
    try {
      videoId = await uploadVideoToYoutube(initData.uploadUrl, videoBlob, initData.accessToken, (p) =>
        onProgress?.({ kind: 'upload-progress', percent: p })
      );
    } catch (err) {
      console.error('[yt-upload] phase=upload-video-to-youtube:error', err?.message, err?.stack);
      throw err;
    }
    console.log('[yt-upload] phase=upload-video-to-youtube:after', { videoId });

    onProgress?.({ kind: 'video-id', videoId });
    return videoId;
  } catch (e) {
    console.error('[yt-upload] phase=runUpload:catch', e?.message, e?.stack);
    onProgress?.({ kind: 'error', phase: 'upload', message: String(e.message || e) });
    return null;
  }
}

/**
 * Attaches a custom thumbnail to a video that's just finished uploading. A no-op (returns true
 * immediately, no request sent) when thumbnailBlob is falsy — the equivalent of the original's
 * "no custom thumbnail made, YouTube's auto-picked one applies" early return.
 */
export async function setThumbnail(videoId, thumbnailBlob, { channel, onProgress } = {}) {
  console.log('[yt-upload] phase=runThumbnail:enter', { videoId, hasThumbnail: !!thumbnailBlob });
  if (!thumbnailBlob) return true;
  onProgress?.({ kind: 'error-clear', phase: 'thumbnail' });
  try {
    const refreshToken = channel?.youtube_refresh_token;
    const dataUrl = await blobToDataUri(thumbnailBlob);
    console.log('[yt-upload] phase=set-thumbnail:before', { videoId, dataUrlLength: dataUrl?.length });
    let res;
    try {
      res = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-thumbnail', channelId: channel?.id, refreshToken, videoId, thumbnailBlob: dataUrl }),
      });
    } catch (err) {
      console.error('[yt-upload] phase=set-thumbnail:fetch-error', err?.message, err?.stack);
      throw err;
    }
    console.log('[yt-upload] phase=set-thumbnail:after', { status: res.status, ok: res.ok });
    const data = await res.json();
    if (!res.ok) {
      // error is a string for our own validation failures, but a boolean flag when it's a
      // passthrough of Google's response (see api/youtube.js set-thumbnail) — the real message
      // is in detail/status in that case.
      const message =
        typeof data.error === 'string' && data.error
          ? data.error
          : `YouTube rejected the thumbnail (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
      throw new Error(message);
    }
    return true;
  } catch (e) {
    console.error('[yt-upload] phase=runThumbnail:catch', e?.message, e?.stack);
    onProgress?.({ kind: 'error', phase: 'thumbnail', message: String(e.message || e) });
    return false;
  }
}

/**
 * Attaches the .srt captions built from the project's scene narration timing. A no-op when
 * metadata.uploadCaptions is falsy, matching the original's ytUploadCaptions checkbox gate.
 */
export async function setCaptions(videoId, project, { channel, metadata, onProgress } = {}) {
  console.log('[yt-upload] phase=runCaptions:enter', { videoId, uploadCaptions: metadata?.uploadCaptions });
  if (!metadata?.uploadCaptions) return true;
  onProgress?.({ kind: 'error-clear', phase: 'captions' });
  try {
    const refreshToken = channel?.youtube_refresh_token;
    const srtContent = buildSrtFromScenes(project.scenes);
    console.log('[yt-upload] phase=set-captions:before', { videoId, srtLength: srtContent?.length });
    let res;
    try {
      res = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-captions', channelId: channel?.id, refreshToken, videoId, srtContent, language: metadata.language }),
      });
    } catch (err) {
      console.error('[yt-upload] phase=set-captions:fetch-error', err?.message, err?.stack);
      throw err;
    }
    console.log('[yt-upload] phase=set-captions:after', { status: res.status, ok: res.ok });
    const data = await res.json();
    if (!res.ok) {
      // error is a string for our own validation failures, but a boolean flag when it's a
      // passthrough of Google's response (see api/youtube.js set-captions) — the real message
      // is in detail/status in that case.
      const message =
        typeof data.error === 'string' && data.error
          ? data.error
          : `YouTube rejected the captions (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
      throw new Error(message);
    }
    return true;
  } catch (e) {
    console.error('[yt-upload] phase=runCaptions:catch', e?.message, e?.stack);
    onProgress?.({ kind: 'error', phase: 'captions', message: String(e.message || e) });
    return false;
  }
}

/**
 * Finds (or creates) the series playlist and adds the video to it. A no-op when
 * metadata.addToPlaylist is falsy or the project has no series, matching the original's
 * ytAddToPlaylist checkbox + project.series gate.
 */
export async function addToSeriesPlaylist(videoId, project, { channel, metadata, onProgress } = {}) {
  console.log('[yt-upload] phase=runPlaylist:enter', { videoId, addToPlaylist: metadata?.addToPlaylist, series: project.series });
  if (!metadata?.addToPlaylist || !project.series) return true;
  onProgress?.({ kind: 'error-clear', phase: 'playlist' });
  try {
    const refreshToken = channel?.youtube_refresh_token;
    console.log('[yt-upload] phase=add-to-playlist:before', { videoId, seriesName: project.series });
    let res;
    try {
      res = await fetch('/api/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-to-playlist', channelId: channel?.id, refreshToken, videoId, seriesName: project.series }),
      });
    } catch (err) {
      console.error('[yt-upload] phase=add-to-playlist:fetch-error', err?.message, err?.stack);
      throw err;
    }
    console.log('[yt-upload] phase=add-to-playlist:after', { status: res.status, ok: res.ok });
    const data = await res.json();
    if (!res.ok) {
      // error is a string for our own validation failures, but a boolean flag when it's a
      // passthrough of Google's response (see api/youtube.js add-to-playlist) — the real message
      // is in detail/status in that case.
      const message =
        typeof data.error === 'string' && data.error
          ? data.error
          : `Could not add the video to its series playlist (HTTP ${data.status ?? res.status}): ${data.detail || 'Unknown error'}`;
      throw new Error(message);
    }
    return true;
  } catch (e) {
    console.error('[yt-upload] phase=runPlaylist:catch', e?.message, e?.stack);
    onProgress?.({ kind: 'error', phase: 'playlist', message: String(e.message || e) });
    return false;
  }
}

/**
 * Full publish sequence: upload → thumbnail → captions → playlist, in that order, stopping after
 * upload if it failed (matching ExportStep's publishToYoutube: later phases only run `if (videoId)`).
 * Returns the video id (or null if the upload itself failed) — same as the original returning
 * nothing meaningful to await, since every phase's outcome is really observed via onProgress.
 *
 * metadata: same shape as uploadVideo's above, plus uploadCaptions/addToPlaylist (the two
 * checkbox toggles ExportStep exposes for the later phases).
 */
export async function publishToYoutube(project, videoBlob, thumbnailBlob, { channel, metadata, onProgress } = {}) {
  console.log('[yt-upload] phase=publishToYoutube:enter');
  const videoId = await uploadVideo(project, videoBlob, { channel, metadata, onProgress });
  console.log('[yt-upload] phase=publishToYoutube:after-upload', { videoId });
  if (videoId) {
    await setThumbnail(videoId, thumbnailBlob, { channel, onProgress });
    await setCaptions(videoId, project, { channel, metadata, onProgress });
    await addToSeriesPlaylist(videoId, project, { channel, metadata, onProgress });
  }
  console.log('[yt-upload] phase=publishToYoutube:exit');
  return videoId;
}
