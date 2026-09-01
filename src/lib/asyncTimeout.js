// Race a promise-returning fn against a timer.
//
// fn(signal) receives an AbortSignal it MAY honour — a fetch() passed the signal will actually
// cancel the in-flight request. When fn can't honour it (uploadMedia has no signal support, an
// <img> load can't be aborted), this STILL stops the caller waiting after timeoutMs: a stalled
// connection that never resolves and never rejects can otherwise hang a whole automation cycle
// forever with no error row ever written — exactly the render→thumbnail freeze this guards against.
//
// On timeout it rejects with an Error tagged `.name = 'TimeoutError'` and a message built from
// `label`, so the phase's own try/catch logs a clear, visible failure instead of the recipe
// awaiting indefinitely.
export function withTimeout(fn, timeoutMs, label = 'operation') {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // TEMPORARY debug (render→thumbnail freeze investigation) — remove once root-caused.
  console.warn(`[rt-debug] withTimeout START — ${label} (limit ${Math.round(timeoutMs / 1000)}s)`);
  const startedAt = Date.now();
  return Promise.resolve()
    .then(() => fn(controller.signal))
    .then(
      (result) => {
        console.warn(`[rt-debug] withTimeout DONE — ${label} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        return result;
      },
      (err) => {
        if (timedOut) {
          console.warn(`[rt-debug] withTimeout TIMEOUT — ${label} (after ${Math.round(timeoutMs / 1000)}s)`);
          const e = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s — treating it as a failure rather than waiting forever.`);
          e.name = 'TimeoutError';
          throw e;
        }
        console.warn(`[rt-debug] withTimeout ERROR — ${label} (${Math.round((Date.now() - startedAt) / 1000)}s): ${String(err?.message || err)}`);
        throw err;
      }
    )
    .finally(() => clearTimeout(timer));
}
