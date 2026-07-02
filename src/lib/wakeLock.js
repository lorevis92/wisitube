// Keeps the screen on during long unattended generation runs. No-op on browsers without support.
let wakeLock = null;

export async function acquireWakeLock() {
  try {
    if (navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    wakeLock = null;
  }
}

export async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    /* ignore */
  } finally {
    wakeLock = null;
  }
}
