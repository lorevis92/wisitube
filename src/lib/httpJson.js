// A JSON POST that never lets a non-JSON response surface as the cryptic, context-free
// "Unexpected token 'X', "..." is not valid JSON" SyntaxError a bare `await res.json()` throws.
// That symptom isn't specific to any one cause — a platform-level failure (Vercel's own
// maxDuration timeout, a DEPLOYMENT_DISABLED/billing block, an edge or proxy error page) can return
// plain text or HTML with an HTTP status that still looks like an ordinary response, and none of
// that ever reaches the caller if the parse itself is what throws. Reading the body as text first
// and reporting the real HTTP status plus a snippet of what actually came back means every caller's
// error message is immediately diagnosable — this exact class of bug (2026-09-16: a whole
// deployment disabled for billing, discovered only because thumbnail generation's error message was
// an unreadable parse error) is what this exists to make readable the next time, whatever the cause.
//
// Mirrors src/lib/contentProgramManager.js's own local postJSON — that one predates this shared
// version and is left as-is rather than migrated, to keep this change targeted.
export async function postJSON(url, body, { signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[httpJson] non-JSON response from', url, 'status=', res.status, 'body=', rawText.slice(0, 300));
    throw new Error(`${url} returned a non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 150) || '(empty body)'}`);
  }
  return { ok: res.ok, status: res.status, data };
}
