// WisiTube — fal.ai account balance read (Vercel Serverless Function)
// CRITICAL: this is a Serverless Function: handler(req, res) + res.status().json().
// Never convert to Edge (runtime: 'edge' / new Response()) — the two APIs are incompatible.
//
// Powers the proactive low-balance heads-up automationEngine.js logs once at the start of a real
// cycle (see warnIfFalBalanceLow there). Deliberately best-effort: every non-success path returns a
// plain error the caller treats as "couldn't determine the balance, so don't warn" — never as a
// reason to stop a cycle.
//
// Note on auth: fal.ai's billing endpoint (https://api.fal.ai/v1/account/billing) expects an ADMIN
// API key, not a plain model key. If FAL_KEY is a model key it will 401/403 here — that's handled
// (the caller just skips the warning), but topping the check up to actually work needs an admin key
// in FAL_KEY, or a separate FAL_ADMIN_KEY wired in here.

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_ADMIN_KEY || process.env.FAL_KEY;
  if (!falKey) {
    console.error('[fal-balance] phase=config missing FAL_KEY env var');
    return res.status(500).json({ error: 'FAL_KEY not configured' });
  }

  let response;
  try {
    response = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
      headers: { Authorization: `Key ${falKey}` },
    });
  } catch (err) {
    console.error('[fal-balance] phase=fetch-fal', err?.message, err?.stack);
    return res.status(502).json({ error: 'Could not reach the fal.ai billing API', detail: String(err?.message || err).slice(0, 200) });
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (err) {
    console.error('[fal-balance] phase=read-response-body', err?.message);
    return res.status(502).json({ error: 'Could not read the fal.ai billing response body', detail: String(err?.message || err).slice(0, 200) });
  }

  if (!response.ok) {
    // Most likely a plain model key against an admin-only endpoint — logged, not alarmed about.
    console.error('[fal-balance] phase=fal-http-error status=', response.status, 'body=', rawText.slice(0, 200));
    return res.status(response.status).json({ error: `fal.ai billing API returned HTTP ${response.status}`, detail: rawText.slice(0, 200) });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error('[fal-balance] phase=parse-json raw=', rawText.slice(0, 200));
    return res.status(502).json({ error: 'fal.ai billing API returned a non-JSON response', detail: rawText.slice(0, 200) });
  }

  const balanceUsd = data?.credits?.current_balance;
  if (typeof balanceUsd !== 'number') {
    console.error('[fal-balance] phase=extract-balance no credits.current_balance, body=', JSON.stringify(data).slice(0, 200));
    return res.status(502).json({ error: 'fal.ai billing API returned no credits.current_balance (is expand=credits supported for this key?)' });
  }

  return res.status(200).json({ balanceUsd, currency: data?.credits?.currency || 'USD' });
}
