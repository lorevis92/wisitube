// Race a promise-returning fn against a timer — a HARD bound, not just a best-effort abort.
//
// fn(signal) receives an AbortSignal it MAY honour — a fetch() passed the signal will actually
// cancel the in-flight request. When fn can't honour it (uploadMedia has no signal support, an
// <img> load can't be aborted, an XHR that ignores it), this STILL stops the caller waiting after
// timeoutMs: the returned promise is Promise.race'd against the timer, so a stalled connection that
// never resolves and never rejects can no longer hang a whole automation cycle forever with no
// error row ever written — exactly the render/thumbnail/upload freeze this guards against.
//
// On timeout it rejects with an Error tagged `.name = 'TimeoutError'` and a message built from
// `label`, so the phase's own try/catch logs a clear, visible failure instead of the recipe
// awaiting indefinitely. fn's own promise is still allowed to settle afterwards (its rejection is
// swallowed so it never surfaces as an unhandled rejection once the race is already lost).
export function withTimeout(fn, timeoutMs, label = 'operation') {
  const controller = new AbortController();
  let timer;

  const fnPromise = Promise.resolve().then(() => fn(controller.signal));
  // Once the race is decided by the timer, fn may still reject later (e.g. because we aborted it) —
  // attach a no-op catch so that late rejection is considered handled.
  fnPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error(
        `${label} timed out after ${Math.round(timeoutMs / 1000)}s — treating it as a failure rather than waiting forever.`
      );
      e.name = 'TimeoutError';
      reject(e);
    }, timeoutMs);
  });

  return Promise.race([fnPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}
