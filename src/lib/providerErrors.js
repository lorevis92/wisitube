// Shared recognition of "the account is out of money" failures from the two paid providers this
// app calls: fal.ai (synchronous narration + synchronous images) and Google's Gemini Batch API
// (batch images). The two return completely different error shapes, so each gets its own matcher,
// but both resolve to a single clear, action-oriented line the UI can show verbatim instead of a
// raw provider blob or a generic "generation failed".
//
// Deliberately tolerant — matched on a few case-insensitive keywords, never a brittle full-string
// compare:
//   - fal.ai's real body (confirmed HTTP 403) is
//       {"detail":"User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing"}
//   - Google's wording for an exhausted allowance varies between RESOURCE_EXHAUSTED, "quota", and
//     "billing" depending on plan and cause.
// A future reword of either would still be caught; an exact-string match would silently miss it,
// which is the whole failure mode this module exists to prevent (a guessed string that never
// matches the real response).
//
// Framework-agnostic and dependency-free: imported by both the Vercel functions under api/ and the
// browser-side engine modules.

// Every message this module emits starts with this marker so a consumer can tell a billing failure
// apart from an ordinary error without re-parsing it (the Storyboard status dot, the automation-log
// row colour, the recipe's "which kind of failure was this" check).
export const CREDIT_ERROR_MARKER = '💳';

export const FAL_CREDIT_EXHAUSTED_MESSAGE =
  '💳 fal.ai credit exhausted — top up at fal.ai/dashboard/billing';
export const GOOGLE_BATCH_CREDIT_EXHAUSTED_MESSAGE =
  '💳 Google Cloud billing/quota exhausted for Gemini Batch — check console.cloud.google.com/billing';

// Machine-readable codes the api/ functions attach alongside the human message, so a client can
// branch on the cause without string-matching the message either.
export const FAL_CREDIT_EXHAUSTED_CODE = 'fal_credit_exhausted';
export const GOOGLE_CREDIT_EXHAUSTED_CODE = 'google_credit_exhausted';

export function isCreditExhaustedMessage(message) {
  return typeof message === 'string' && message.startsWith(CREDIT_ERROR_MARKER);
}

// ---- fal.ai ----

// fal.run returns HTTP 403 with a { detail } body when the account is locked for an exhausted
// balance. `status` is the HTTP status fal returned; `body` is the raw response body — a string
// (the common case) or an already-parsed object, both accepted since callers hold it in different
// forms.
export function isFalCreditExhausted(status, body) {
  const text = (typeof body === 'string' ? body : safeStringify(body)).toLowerCase();
  if (!text) return false;

  // fal's own phrasing for this, distinctive enough to trust regardless of the status code a
  // given endpoint or proxy layer surfaces.
  if (/exhausted balance|top up your balance|user is locked/.test(text)) return true;

  // Otherwise gate on the status fal actually uses (403) AND a balance/credit keyword, so an
  // unrelated 403 (bad key, region block, content policy) isn't mislabelled as a billing problem.
  return status === 403 && /\b(balance|credit|credits|exhaust\w*|insufficient|top ?up|out of funds|no funds)\b/.test(text);
}

// ---- Google Gemini Batch API ----

// Google returns { error: { code, message, status } } (sometimes the bare inner object, sometimes
// a raw string). RESOURCE_EXHAUSTED / HTTP 429 is Google's code for both a transient per-minute
// rate limit AND a used-up daily/free-tier allowance — this matcher only claims the cases whose
// message actually points at quota or billing, so a transient rate limit (handled by
// geminiBatchImageEngine.js's own retry/backoff) isn't permanently relabelled as "out of credit".
export function isGoogleBatchCreditExhausted(input) {
  if (!input) return false;
  if (typeof input === 'string') {
    const t = input.toLowerCase();
    return /resource_exhausted|permission_denied/.test(t) && /quota|billing|credit|exhaust|exceeded/.test(t);
  }
  const err = input.error || input;
  const status = String(err.status || '').toUpperCase();
  const code = Number(err.code);
  const message = String(err.message || '').toLowerCase();

  if (status === 'RESOURCE_EXHAUSTED' || code === 429) {
    return /quota|billing|free tier|free_tier|exceeded your current quota|out of|exhaust/.test(message);
  }
  if (status === 'PERMISSION_DENIED' || code === 403) {
    return /billing|quota|not been enabled|disabled/.test(message);
  }
  return /quota exceeded|billing account|insufficient (?:funds|credit)/.test(message);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v ?? '');
  } catch {
    return String(v ?? '');
  }
}
