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

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => {
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
      };
      xhr.onerror = () => {
        console.error('[yt-upload] phase=xhr-onerror', { uploadUrl, readyState: xhr.readyState, status: xhr.status });
        reject(new Error('Network error during the YouTube upload'));
      };
      xhr.onabort = () => {
        console.error('[yt-upload] phase=xhr-onabort', { uploadUrl });
        reject(new Error('YouTube upload cancelled'));
      };

      console.log('[yt-upload] phase=xhr-send:before', { blobSize: videoBlob?.size });
      xhr.send(videoBlob);
      console.log('[yt-upload] phase=xhr-send:after');
    } catch (err) {
      console.error('[yt-upload] phase=uploadVideoToYoutube:sync-error', err?.message, err?.stack);
      reject(err);
    }
  });
}
