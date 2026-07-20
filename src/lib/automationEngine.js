// Multi-channel automation engine — Phase 1: the cycle loop, its safety caps, and its
// observability, running in dry-run mode only. Nothing here calls a generation API, spends money,
// or publishes anything; every "would do X" step is a log line describing what a real cycle would
// have done at that point. Phase 2 wires getRecipeForContentType's placeholder id to the actual
// titles → outline → scenes → media → render → thumbnail → YouTube pipeline.
import { saveChannel, listChannels, logAutomationStep } from './db';

const PAID_IMAGE_PROVIDERS = ['nanobanana', 'gptimage'];
const PAID_VOICE_ENGINES = ['minimax'];

// 'YYYY-MM-DD' in the browser's local timezone — matches what a user means by "today" when they
// set a daily cap, and is stable to store/compare as a plain string.
function todayDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// If the channel's daily counters were last reset before today, zero them and stamp today's date.
// A no-op (no network call) when they're already current — every cycle calls this per channel, so
// it needs to be cheap on the common case.
export async function resetDailyCountersIfNeeded(channel) {
  const today = todayDateString();
  if (channel.automation_last_reset_date && channel.automation_last_reset_date >= today) return channel;
  return saveChannel({
    ...channel,
    automation_daily_upload_count: 0,
    automation_daily_spend_usd: 0,
    automation_last_reset_date: today,
  });
}

// { ok: boolean, reason: string | null } rather than a bare boolean — every false case needs a
// reason the caller can log (see runAutomationCycle), so the two travel together instead of the
// caller having to re-derive why.
export function canRunChannelToday(channel) {
  if (channel.automation_enabled !== true) {
    return { ok: false, reason: 'automation disabled for this channel' };
  }

  const videosPerDay = Number(channel.automation_videos_per_day) || 0;
  const uploadsToday = Number(channel.automation_daily_upload_count) || 0;
  if (uploadsToday >= videosPerDay) {
    return { ok: false, reason: `daily upload cap reached (${uploadsToday}/${videosPerDay})` };
  }

  const budget = Number(channel.automation_daily_budget_usd) || 0;
  const usesPaidProvider =
    PAID_IMAGE_PROVIDERS.includes(channel.automation_image_provider) || PAID_VOICE_ENGINES.includes(channel.automation_voice_engine);

  if (budget === 0) {
    if (usesPaidProvider) return { ok: false, reason: 'premium provider requires a budget > 0' };
    return { ok: true, reason: null };
  }

  const spentToday = Number(channel.automation_daily_spend_usd) || 0;
  if (spentToday >= budget) {
    return { ok: false, reason: `daily budget reached ($${spentToday.toFixed(2)}/$${budget.toFixed(2)})` };
  }

  return { ok: true, reason: null };
}

// Placeholder recipe registry — Phase 2 replaces the string id with the actual pipeline function
// reference (or a lookup into one). Only 'full_pipeline' exists today; everything else means "no
// recipe available for this content type yet," not an error.
export function getRecipeForContentType(contentType) {
  switch (contentType) {
    case 'full_pipeline':
      return 'full_pipeline';
    default:
      return null;
  }
}

// Thin, literally-named wrapper around db.js's insert — kept as its own export here because the
// rest of the engine (and any future recipe implementation) calls it as `logStep`, but the actual
// Supabase access stays centralized in db.js like every other table in this app.
export async function logStep(channelId, videoId, step, status, message) {
  return logAutomationStep(channelId, videoId, step, status, message);
}

// The exact sequence of phases a real (non-dry-run) cycle would run through for 'full_pipeline' —
// {provider} is substituted with the channel's configured image provider; everything else is
// deliberately left as literal, non-computed text since the real numbers (scene count, etc.)
// depend on pipeline internals Phase 2 hasn't wired up yet.
const DRY_RUN_STEPS = [
  { step: 'suggestion', message: 'would fetch a suggestion from Content Program Manager' },
  { step: 'outline', message: 'would generate outline for chosen topic' },
  { step: 'scenes', message: 'would generate N scene chunks' },
  { step: 'media', message: 'would generate images/audio via {provider}' },
  { step: 'render', message: 'would render MP4' },
  { step: 'thumbnail', message: 'would create thumbnail' },
  { step: 'youtube', message: 'would upload to YouTube' },
];

/**
 * userId: the authenticated user running this cycle — not used to filter here (listChannels()
 * already comes back scoped to the caller via Supabase RLS), kept as a parameter for the caller's
 * own bookkeeping and so callers don't have to thread session state through some other path.
 * dryRun: when true (the only supported value in Phase 1), no generation/spend/publish APIs are
 * called — every eligible channel just gets its would-be steps logged.
 * onUpdate({ channelId, channelName, index, total, status }): called once per channel, after that
 * channel's turn is fully resolved (skipped, dry-run logged, or errored) — status is
 * 'skipped' | 'done' | 'error'.
 * shouldStop(): polled once at the top of each channel's turn (never mid-channel) — returning true
 * ends the cycle immediately without starting the next channel.
 */
export async function runAutomationCycle({ userId, dryRun = true, onUpdate, shouldStop = () => false }) {
  const allChannels = await listChannels();
  const channels = allChannels.filter((c) => c.automation_enabled === true);

  for (let i = 0; i < channels.length; i++) {
    if (shouldStop()) break;

    let channel = channels[i];
    const report = (status) => onUpdate?.({ channelId: channel.id, channelName: channel.name, index: i, total: channels.length, status });

    try {
      channel = await resetDailyCountersIfNeeded(channel);

      const recipe = getRecipeForContentType(channel.content_type);
      if (!recipe) {
        await logStep(channel.id, null, 'recipe', 'skipped', `no recipe for content_type "${channel.content_type || '(none)'}"`);
        report('skipped');
        continue;
      }

      const { ok, reason } = canRunChannelToday(channel);
      if (!ok) {
        await logStep(channel.id, null, 'eligibility', 'skipped', reason);
        report('skipped');
        continue;
      }

      if (dryRun) {
        const provider = channel.automation_image_provider || 'pollinations';
        for (const { step, message } of DRY_RUN_STEPS) {
          await logStep(channel.id, null, step, 'dry_run', message.replace('{provider}', provider));
        }
      }
      // Real (non-dry-run) execution: Phase 2 branches on `recipe` here to actually run the
      // pipeline, then bump automation_daily_upload_count/automation_daily_spend_usd. Not wired up
      // yet — dryRun is the only mode this phase supports.

      report('done');
    } catch (err) {
      console.error('[automationEngine] channel cycle failed', channel?.id, err);
      await logStep(channel?.id, null, 'cycle', 'error', String(err?.message || err));
      report('error');
    }
  }
}
