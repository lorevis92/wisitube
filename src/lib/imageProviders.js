// Shared image-provider config — imported by both api/generate-image.js (server-side, to compute
// the actual per-image costUsd charged) and the client (to show a cost estimate + confirmation
// dialog before any paid generation starts). Pollinations is always free; Nano Banana 2 and GPT
// Image 2 are both routed through fal.ai as a single external provider.

export const PROVIDER_LABELS = {
  pollinations: 'Pollinations (Free)',
  nanobanana: 'Nano Banana 2 (~$0.08/image)',
  // quality is hardcoded 'medium' at every real call site (mediaGenerationEngine.js,
  // thumbnailEngine.js, StoryboardStep.jsx, automationEngine.js) — there's no UI control to select
  // 'low'/'high' yet, so the low ($0.006) and high ($0.211) GPTIMAGE_PRICES tiers below are never
  // actually charged. The label reflects what's really billed today (medium, plus the reference
  // surcharge) rather than the full range the price table could theoretically produce — if quality
  // ever becomes user-selectable, this label needs revisiting alongside that UI addition.
  gptimage: 'GPT Image 2 (~$0.05/image, +50% with reference photos)',
  // Selectable in both the manual flow (CreateStep.jsx/StoryboardStep.jsx) and automation
  // (AutomationStep.jsx) — same provider id, same label, everywhere. Generation itself is async
  // (submit now, resolve later — see geminiBatchImageEngine.js/batchResumption.js), which is why the
  // label says so upfront rather than surprising the user with a stalled-looking "Generate" button.
  'nanobanana-batch': 'Nano Banana 2 (Batch, ~$0.0225/image, may take hours)',
};

export const NANOBANANA_PRICES = { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 };
// Gemini Batch API pricing for image generation (see api/gemini-batch.js) — deliberately separate
// from NANOBANANA_PRICES above: same underlying model family, but routed directly through Google's
// batch endpoint instead of fal.ai, at batch's discounted rate. Only the 0.5K tier is priced so far
// (the resolution this mechanism actually runs at today, see fullPipelineRecipe.js's media phase).
export const NANOBANANA_BATCH_PRICES = { '0.5K': 0.0225 };
export const GPTIMAGE_PRICES = { low: 0.006, medium: 0.053, high: 0.211 };
// GPT Image 2 always bills high-fidelity input at its maximum rate when a reference image is
// present, so the estimate/cost gets a flat margin added in that case rather than trying to
// predict OpenAI's exact internal billing tier.
export const GPTIMAGE_REFERENCE_SURCHARGE = 0.5;

// Buckets arbitrary pixel dimensions into the resolution tiers fal.ai / our price table use.
export function resolutionTier(width, height) {
  const maxDim = Math.max(width, height);
  if (maxDim <= 512) return '0.5K';
  if (maxDim <= 1280) return '1K';
  if (maxDim <= 2048) return '2K';
  return '4K';
}

/**
 * Single source of truth for per-image cost, in USD. Returns 0 for pollinations (and for any
 * unrecognized provider, so callers never accidentally treat an unknown provider as billable).
 */
export function priceForImage(provider, { width = 1280, height = 720, quality = 'medium', hasReference = false } = {}) {
  if (provider === 'nanobanana') {
    const tier = resolutionTier(width, height);
    return NANOBANANA_PRICES[tier] ?? NANOBANANA_PRICES['1K'];
  }
  if (provider === 'nanobanana-batch') {
    // Deliberately ignores the width/height passed in — every real caller (geminiBatchImageEngine.js,
    // fullPipelineRecipe.js, StoryboardStep.jsx, AutomationStep.jsx) hardcodes resolution: '0.5K' for
    // the actual batch submission, but callers computing a cost *estimate* (StoryboardStep.jsx's
    // estimateCost, automationEngine.js's estimateFullPipelineCost) pass the video's display dims
    // (1280x720 or 720x1280), which resolutionTier() maps to '1K' — a tier NANOBANANA_BATCH_PRICES
    // doesn't define. That silently worked only because the `??` fallback below happened to land on
    // the one tier that does exist; deriving the tier from dims here was never actually correct, just
    // unobservably so. Hardcode '0.5K' explicitly instead — if another batch resolution tier is ever
    // added, whoever adds it will find this line and needs to decide how estimates should pick a
    // tier, rather than the estimate silently going stale.
    return NANOBANANA_BATCH_PRICES['0.5K'];
  }
  if (provider === 'gptimage') {
    const base = GPTIMAGE_PRICES[quality] ?? GPTIMAGE_PRICES.medium;
    return hasReference ? base * (1 + GPTIMAGE_REFERENCE_SURCHARGE) : base;
  }
  return 0;
}
