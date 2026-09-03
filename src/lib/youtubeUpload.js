// Direct browser -> YouTube resumable upload of the already-rendered video Blob. The upload URL
// itself (minted by api/youtube.js, action=init-upload) is a single-use, pre-authorized session endpoint,
// so the bytes never pass through our own server — only metadata calls do. Uses XMLHttpRequest
// instead of fetch specifically for upload.onprogress, which fetch doesn't expose reliably.
export function uploadVideoToYoutube(uploadUrl, videoBlob, accessToken, onProgress) {
  console.log('[yt-upload] phase=uploadVideoToYoutube:enter', {
    uploadUrl,
    uploadUrlType: typeof uploadUrl,
    blobSize: videoBlob?.size,
    blobType: videoBlob?.type,
    hasAccessToken: !!accessToken,
    hasOnProgress: typeof onProgress === 'function',
  });
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      console.log('[yt-upload] phase=xhr-open:before', { method: 'PUT', uploadUrl });
      xhr.open('PUT', uploadUrl, true);
      console.log('[yt-upload] phase=xhr-open:after');
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.setRequestHeader('Content-Type', 'video/mp4');

      // Idle-stall guard. A resumable PUT that connects then goes silent — the connection drops
      // without the browser ever firing xhr.onerror, common on flaky mobile/VPN links, and also the
      // "bytes went out, response never came back" case — otherwise leaves this Promise pending
      // FOREVER, hanging the recipe's YouTube phase and, with it, the scheduler's currently_running
      // lock (whose heartbeat keeps ticking because the JS event loop isn't blocked). Abort if
      // there's no upload progress and no completion for STALL_MS.
      const STALL_MS = 120 * 1000;
      let settled = false;
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.error('[yt-upload] phase=xhr-stall-abort', { uploadUrl, readyState: xhr.readyState });
          try {
            xhr.abort();
          } catch {
            /* ignore */
          }
          reject(
            new Error(
              `YouTube upload stalled — no progress for ${STALL_MS / 1000}s. The video may or may not have been created; check YouTube Studio before retrying.`
            )
          );
        }, STALL_MS);
      };
      const done = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        fn(...args);
      };

      armStall();

      xhr.upload.onprogress = (e) => {
        armStall();
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = done(() => {
        console.log('[yt-upload] phase=xhr-onload', { status: xhr.status });
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (!data.id) {
              console.error('[yt-upload] phase=xhr-onload:no-video-id', xhr.responseText?.slice(0, 300));
              reject(new Error('YouTube upload succeeded but returned no video id'));
              return;
            }
            resolve(data.id);
          } catch (err) {
            console.error('[yt-upload] phase=xhr-onload:parse-error', err?.message, err?.stack);
            reject(new Error('Could not parse the YouTube upload response'));
          }
        } else {
          console.error('[yt-upload] phase=xhr-onload:http-error', xhr.status, xhr.responseText?.slice(0, 300));
          reject(new Error(`YouTube upload failed (HTTP ${xhr.status}): ${String(xhr.responseText || '').slice(0, 300)}`));
        }
      });
      xhr.onerror = done(() => {
        console.error('[yt-upload] phase=xhr-onerror', { uploadUrl, readyState: xhr.readyState, status: xhr.status });
        reject(new Error('Network error during the YouTube upload'));
      });
      xhr.onabort = done(() => {
        console.error('[yt-upload] phase=xhr-onabort', { uploadUrl });
        reject(new Error('YouTube upload cancelled'));
      });

      console.log('[yt-upload] phase=xhr-send:before', { blobSize: videoBlob?.size });
      xhr.send(videoBlob);
      console.log('[yt-upload] phase=xhr-send:after');
    } catch (err) {
      console.error('[yt-upload] phase=uploadVideoToYoutube:sync-error', err?.message, err?.stack);
      reject(err);
    }
  });
}
