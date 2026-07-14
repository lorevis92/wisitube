// Direct browser -> YouTube resumable upload of the already-rendered video Blob. The upload URL
// itself (minted by api/youtube.js, action=init-upload) is a single-use, pre-authorized session endpoint,
// so the bytes never pass through our own server — only metadata calls do. Uses XMLHttpRequest
// instead of fetch specifically for upload.onprogress, which fetch doesn't expose reliably.
export function uploadVideoToYoutube(uploadUrl, videoBlob, accessToken, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Content-Type', 'video/mp4');

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (!data.id) {
            reject(new Error('YouTube upload succeeded but returned no video id'));
            return;
          }
          resolve(data.id);
        } catch {
          reject(new Error('Could not parse the YouTube upload response'));
        }
      } else {
        reject(new Error(`YouTube upload failed (HTTP ${xhr.status}): ${String(xhr.responseText || '').slice(0, 300)}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during the YouTube upload'));
    xhr.onabort = () => reject(new Error('YouTube upload cancelled'));

    xhr.send(videoBlob);
  });
}
