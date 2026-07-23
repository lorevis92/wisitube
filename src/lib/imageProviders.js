// Shared image-provider config — imported by both api/generate-image.js (server-side, to compute
// the actual per-image costUsd charged) and the client (to show a cost estimate + confirmation
// dialog before any paid generation starts). Pollinations is always free; Nano Banana 2 and GPT
// Image 2 are both routed through fal.ai as a single external provider.

export const PROVIDER_LABELS = {
  pollinations: 'Pollinations (Free)',
  nanobanana: 'Nano Banana 2 (~$0.08/image)',
  gptimage: 'GPT Image 2 (~$0.05-0.21/image)',
};

// Separate from PROVIDER_LABELS above — this option is only meaningful for automation (channel
// automation_image_provider), not the manual per-video imageProvider picker (CreateStep.jsx), since
// a batch job can take hours to resolve and the manual flow expects a generation to finish in the
// same session. AutomationStep.jsx merges this into its own select alongside PROVIDER_LABELS.
export const AUTOMATION_ONLY_PROVIDER_LABELS = {
  'nanobanana-batch': 'Nano Banana 2 (Batch, ~$0.011-0.022/image, may take hours)',
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
    const tier = resolutionTier(width, height);
    return NANOBANANA_BATCH_PRICES[tier] ?? NANOBANANA_BATCH_PRICES['0.5K'];
  }
  if (provider === 'gptimage') {
    const base = GPTIMAGE_PRICES[quality] ?? GPTIMAGE_PRICES.medium;
    return hasReference ? base * (1 + GPTIMAGE_REFERENCE_SURCHARGE) : base;
  }
  return 0;
}
