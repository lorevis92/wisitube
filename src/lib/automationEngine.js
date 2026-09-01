// Multi-channel automation engine. Phase 1 shipped the cycle loop, its safety caps, and its
// observability in dry-run mode only. Phase 2a wires getRecipeForContentType's 'full_pipeline' id
// to the real titles → outline → scenes → media → render → thumbnail → YouTube pipeline
// (src/lib/recipes/fullPipelineRecipe.js) — real generation, real spend, real publishing, but
// still only ever started manually from AutomationStep.jsx (no auto-start; that's Phase 2b).
import { listChannels, logAutomationStep, updateChannelFields, bumpChannelDailyUsage } from './db';
import { priceForImage } from './imageProviders';
import { priceForVoice } from './voiceProviders';
import { runFullPipeline } from './recipes/fullPipelineRecipe';
import { runStaticBackgroundPipeline } from './recipes/staticBackgroundRecipe';
import { isCreditExhaustedMessage } from './providerErrors';
import { runMediaCleanup } from './mediaArchival';

const PAID_IMAGE_PROVIDERS = ['nanobanana', 'gptimage', 'nanobanana-batch'];
const PAID_VOICE_ENGINES = ['minimax'];

// Image providers that actually bill fal.ai. 'nanobanana-batch' is deliberately NOT here — that
// path runs through Google's Gemini Batch API, not fal.ai, so a fal balance check says nothing
// about it.
const FAL_BACKED_IMAGE_PROVIDERS = ['nanobanana', 'gptimage'];

// The scheduler ticks as often as every minute; storage cleanup (src/lib/mediaArchival.js) only
// needs to run about once a day. Throttled with a module-level timestamp rather than a new DB
// column — a page reload just means the next cycle runs it once more, which is harmless (it's a
// no-op when nothing is eligible, and idempotent per video via mediaArchived).
let lastMediaCleanupAt = 0;
const MEDIA_CLEANUP_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

async function runDailyMediaCleanup(userId) {
  if (!userId) return;
  if (Date.now() - lastMediaCleanupAt < MEDIA_CLEANUP_MIN_INTERVAL_MS) return;
  lastMediaCleanupAt = Date.now();
  try {
    const result = await runMediaCleanup(userId, { dryRun: false, log: true });
    if (result.archived > 0 || result.failed > 0) {
      await logAutomationStep(
        null,
        null,
        'cleanup',
        result.failed > 0 ? 'error' : 'success',
        `storage cleanup: archived ${result.archived} published video(s), freed ~${result.freedBytesLabel}${result.failed ? `, ${result.failed} failed` : ''}`
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[automationEngine] daily media cleanup failed', err);
    await logAutomationStep(null, null, 'cleanup', 'error', `storage cleanup failed: ${String(err?.message || err)}`).catch(() => {});
  }
}
// Below this, the cycle logs a one-off heads-up (never blocks) so a mid-video "credit exhausted"
// failure doesn't come as a surprise.
const LOW_FAL_BALANCE_THRESHOLD_USD = 10;

// Best-effort fal.ai balance read via api/fal-balance.js. Returns the USD balance as a number, or
// null when it can't be determined (endpoint down, or the billing API rejected the key — it wants
// an admin key) — a null must never be treated as "low", only as "don't know, don't warn".
async function readFalBalanceUsd() {
  const res = await fetch('/api/fal-balance');
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.balanceUsd === 'number' ? data.balanceUsd : null;
}

// One fal.ai balance check per real cycle — not per channel: the balance is account-wide, so
// re-checking it for every channel would just burn calls for the same number. Only bothers when at
// least one channel in this cycle actually uses a fal-backed engine. A low balance is logged as a
// distinct 'low_balance_warning' row and nothing else; the cycle proceeds exactly as normal.
async function warnIfFalBalanceLow(channels) {
  const anyFalChannel = channels.some(
    (c) => FAL_BACKED_IMAGE_PROVIDERS.includes(c.automation_image_provider) || c.automation_voice_engine === 'minimax'
  );
  if (!anyFalChannel) return;
  try {
    const balance = await readFalBalanceUsd();
    if (balance != null && balance < LOW_FAL_BALANCE_THRESHOLD_USD) {
      await logAutomationStep(
        null,
        null,
        'balance',
        'low_balance_warning',
        `fal.ai balance is $${balance.toFixed(2)} — below $${LOW_FAL_BALANCE_THRESHOLD_USD}. Top up at fal.ai/dashboard/billing to avoid a mid-video "credit exhausted" failure.`
      );
    }
  } catch (err) {
    // Non-fatal by design — a balance check that itself failed must not stop a cycle from running.
    console.error('[automationEngine] fal.ai balance pre-check failed (non-fatal)', err);
  }
}

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
  // Targeted update, NOT a full-row saveChannel: the day's reset must only touch these three
  // columns, never revert whatever else changed on the row since this `channel` snapshot was taken
  // (a dashboard edit, or the recipe's own topic_scoring_cache write later in the cycle).
  const updated = await updateChannelFields(channel.id, {
    automation_daily_upload_count: 0,
    automation_daily_spend_usd: 0,
    automation_last_reset_date: today,
  });
  return updated || channel;
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

// Recipe registry — returns the actual pipeline function for a content type, or null if none
// exists yet (not an error: getRecipeForContentType(null) is how "no recipe available for this
// content type" is represented to the caller, see runAutomationCycle below).
export function getRecipeForContentType(contentType) {
  switch (contentType) {
    case 'full_pipeline':
      return runFullPipeline;
    case 'static_background':
      return runStaticBackgroundPipeline;
    default:
      return null;
  }
}

// Same pricing functions the manual "Confirm paid generation" dialog uses (StoryboardStep.jsx),
// applied to an estimated (not exact) beat count/narration length — real scenes don't exist yet at
// the point runAutomationCycle needs this, only automation_length_minutes. totalScenes mirrors
// api/generate-outline.js's own math so the estimate is at least consistent with what the outline
// call will actually request.
const ESTIMATED_CHARS_PER_SCENE = 120; // generate-scenes.js caps each scene at 200 chars; this is a realistic average, not the worst case.

function estimateFullPipelineCost(channel) {
  // "Let AI decide the ideal length" has no fixed target to estimate from — this pre-flight check
  // exists purely to catch "this channel's budget can't possibly cover a video like this" before
  // any real spend happens, so it deliberately reasons about the worst case rather than a realistic
  // guess. With a safety cap configured, capMaxMinutes IS the worst case the model is allowed to
  // reach (see api/generate-outline.js's clampToSafetyCap). Without one, there's no ceiling at all —
  // 30 minutes is a prudently high stand-in so an unexpectedly long video can't slip past this
  // budget check unnoticed just because there was nothing concrete to estimate from.
  let lengthMinutes;
  if (channel.automation_ai_decides_length === true) {
    const capEnabled = channel.automation_length_cap_enabled !== false;
    lengthMinutes = capEnabled ? Number(channel.automation_length_cap_max) || 45 : 30;
  } else {
    lengthMinutes = Number(channel.automation_length_minutes) || 5;
  }
  const totalScenes = Math.max(6, Math.round(lengthMinutes * 12));
  const provider = channel.automation_image_provider || 'pollinations';
  const voiceEngine = channel.automation_voice_engine || 'kokoro';

  // 'static_background' has no per-scene image_beats at all (see api/generate-scenes.js) — quoting
  // a scenes×2 image cost here would be phantom, same fix as StoryboardStep.jsx's own estimateCost.
  // No background-image cost line either: staticBackgroundRecipe.js never generates a fresh
  // background per video, it reuses the channel's already-configured default image/color as-is
  // (see buildStaticBackgroundFromChannel there) — that image was already billed once, at whatever
  // point the channel owner generated it in ChannelDashboardStep.jsx, not on every automated video.
  const isStaticBackground = channel.content_type === 'static_background';
  const beats = isStaticBackground ? 0 : totalScenes * 2;
  const imageTotal = isStaticBackground
    ? 0
    : beats * priceForImage(provider, { width: 1280, height: 720, quality: 'medium', hasReference: false });
  const voiceTotal = priceForVoice(voiceEngine, totalScenes * ESTIMATED_CHARS_PER_SCENE);
  return imageTotal + voiceTotal;
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
 * already comes back scoped to the caller via Supabase RLS), passed straight through to the recipe
 * (it needs it for Storage paths/cost-ledger writes) and kept for the caller's own bookkeeping.
 * dryRun: true logs the would-be steps without calling any generation/spend/publish API (Phase 1).
 * false actually runs the channel's recipe — real generation, real spend, real YouTube publish.
 * onUpdate({ channelId, channelName, index, total, status }): called once per channel, after that
 * channel's turn is fully resolved — status is 'skipped' | 'done' | 'error'. For a real cycle, a
 * channel's "turn" can now cover several videos in a row (see the exhaustion loop below), but this
 * still fires only once at the end of all of them, not once per video — onProgress (below) is the
 * one that fires per phase/per video.
 * onProgress({ channelId, channelName, step, message, videoId, project }): live, in-memory
 * phase-level updates while a real (non-dry-run) recipe is running — never fires for dry runs
 * (there's no recipe call to report from) or for skipped channels. Tagged with channel identity
 * here so a single callback can drive global UI state (see App.jsx's currentAutomationRun /
 * AutomationMirrorStep.jsx) without needing to know which channel is currently active. Fires once
 * per video started, not once per channel — a channel producing several videos in a row emits one
 * 'starting' (and its own phase sequence) per video.
 * shouldStop(): polled at the top of each channel's turn AND between videos of the same channel
 * (see the exhaustion loop below) — never mid-video. Returning true ends the current channel's
 * turn (finishing whatever video is already in flight) and, on the next channel-loop iteration,
 * ends the whole cycle without starting another channel.
 */
export async function runAutomationCycle({ userId, dryRun = true, onUpdate, onProgress, shouldStop = () => false }) {
  console.warn('[run-cycle-debug] runAutomationCycle() entered', { dryRun });
  const allChannels = await listChannels();
  console.warn('[run-cycle-debug] runAutomationCycle() listChannels() returned', allChannels.length, 'channels');
  // Deterministic, stable processing order: oldest channel first, by creation time. listChannels()
  // returns updated_at DESC, which is reshuffled constantly (this very cycle bumps updated_at on
  // every channel it touches — daily counters, topic_scoring_cache — as does any dashboard edit), so
  // iterating it directly would systematically favour or starve a channel purely by how recently
  // something else happened to touch its row. created_at never changes.
  const channels = allChannels
    .filter((c) => c.automation_enabled === true)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  console.warn('[run-cycle-debug] runAutomationCycle()', channels.length, 'channels have automation_enabled === true');

  // Proactive, non-blocking low-balance heads-up — real cycles only (a dry run spends nothing).
  if (!dryRun) await warnIfFalBalanceLow(channels);

  for (let i = 0; i < channels.length; i++) {
    if (shouldStop()) break;

    let channel = channels[i];
    console.warn('[run-cycle-debug] runAutomationCycle() processing channel', i + 1, '/', channels.length, channel.id, channel.name);
    const report = (status) => onUpdate?.({ channelId: channel.id, channelName: channel.name, index: i, total: channels.length, status });

    try {
      channel = await resetDailyCountersIfNeeded(channel);

      const recipe = getRecipeForContentType(channel.content_type);
      if (!recipe) {
        console.warn('[run-cycle-debug] runAutomationCycle() no recipe for content_type — skipping channel', channel.content_type);
        await logStep(channel.id, null, 'recipe', 'skipped', `no recipe for content_type "${channel.content_type || '(none)'}"`);
        report('skipped');
        continue;
      }

      const { ok, reason } = canRunChannelToday(channel);
      if (!ok) {
        console.warn('[run-cycle-debug] runAutomationCycle() canRunChannelToday() said no — skipping channel', reason);
        await logStep(channel.id, null, 'eligibility', 'skipped', reason);
        report('skipped');
        continue;
      }

      if (dryRun) {
        const provider = channel.automation_image_provider || 'pollinations';
        for (const { step, message } of DRY_RUN_STEPS) {
          await logStep(channel.id, null, step, 'dry_run', message.replace('{provider}', provider));
        }
        report('done');
      } else {
        // Exhaust this channel's daily quota before moving on to the next channel: keep generating
        // videos on it until canRunChannelToday says no (upload cap reached or budget exhausted) or
        // the caller asks to stop — not just one video then straight to the next channel. `channel`
        // is reassigned to bumpChannelDailyUsage's own return after every video, since
        // automation_daily_upload_count/automation_daily_spend_usd were just updated and the next
        // canRunChannelToday/budget check needs to see that, not the stale pre-run values.
        let videosCompleted = 0;
        let videoInProgress = false;
        let exhaustionReason = null;
        while (true) {
          // Pre-flight budget check — the recipe itself only finds out the real cost as it spends
          // it (via recordCost calls deep inside mediaGenerationEngine.js/thumbnailEngine.js), so
          // this has to be an estimate computed before any of that runs, not a check against real
          // spend. Re-evaluated every iteration since `channel`'s spend just changed.
          const budget = Number(channel.automation_daily_budget_usd) || 0;
          const spent = Number(channel.automation_daily_spend_usd) || 0;
          const estimate = estimateFullPipelineCost(channel);
          if (budget > 0 && estimate > budget - spent) {
            exhaustionReason = 'estimated cost exceeds remaining daily budget';
            break;
          }

          onProgress?.({ channelId: channel.id, channelName: channel.name, step: 'starting', message: 'Starting run…' });
          console.warn('[run-cycle-debug] runAutomationCycle() about to call recipe() — the first real generation call', {
            channelId: channel.id,
            contentType: channel.content_type,
            recipeName: recipe.name,
          });
          // eslint-disable-next-line no-await-in-loop
          const result = await recipe(channel, {
            userId,
            logStep,
            onProgress: (evt) => onProgress?.({ channelId: channel.id, channelName: channel.name, ...evt }),
          });
          console.warn('[run-cycle-debug] runAutomationCycle() recipe() returned', result);

          if (result.inProgress) {
            // Gemini Batch jobs are still running for this video (see fullPipelineRecipe.js's
            // media phase) — nothing failed, there's just nothing left to do until Google
            // finishes them. Spend so far is real and counted; the upload count is not, since no
            // video was actually produced yet. Stops the exhaustion loop for this channel this
            // cycle rather than starting ANOTHER new video on top of the one still in flight —
            // it'll be picked up (resumed) automatically on a later cycle.
            //
            // bumpChannelDailyUsage (fresh read + targeted write) rather than a full-row saveChannel
            // from `channel` — the recipe just edited this same row's topic_scoring_cache (removing
            // the suggestion it started), and a stale-snapshot upsert here would revert that.
            // eslint-disable-next-line no-await-in-loop
            const bumped = await bumpChannelDailyUsage(channel.id, { spendDeltaUsd: result.costUsd || 0 });
            if (bumped) channel = bumped;
            videoInProgress = true;
            // eslint-disable-next-line no-await-in-loop
            await logStep(channel.id, result.videoId, 'cycle', 'pending', 'video still in progress (Gemini Batch jobs running) — will resume next cycle');
            break;
          }

          // A failed run never reaches here (the recipe throws, caught below) — so the upload
          // count only ever increments for a video that actually finished and published.
          //
          // bumpChannelDailyUsage: fresh read + targeted write of just the two counters, so this
          // never reverts the recipe's mid-cycle topic_scoring_cache edit (or a dashboard change
          // made while this video was generating). The returned `channel` carries the fresh cache,
          // so the next exhaustion-loop iteration's getTopicSuggestions sees the already-used
          // suggestion removed and picks a different topic — no duplicate-topic video in one cycle.
          // eslint-disable-next-line no-await-in-loop
          const bumped = await bumpChannelDailyUsage(channel.id, {
            uploadCountDelta: 1,
            spendDeltaUsd: result.costUsd || 0,
          });
          if (bumped) channel = bumped;
          videosCompleted++;

          if (shouldStop()) break;
          const next = canRunChannelToday(channel);
          if (!next.ok) {
            exhaustionReason = next.reason;
            break;
          }
        }

        if (exhaustionReason) {
          await logStep(
            channel.id,
            null,
            'eligibility',
            'skipped',
            `${exhaustionReason} (after ${videosCompleted} video${videosCompleted === 1 ? '' : 's'} this cycle)`
          );
        }

        // Zero videos produced this turn (e.g. the budget estimate failed on the very first
        // attempt) is still a genuine skip, not a "done" — same distinction the pre-existing
        // single-run code made. A video left in progress counts as "done" for this turn even
        // though videosCompleted is 0 — something real happened, it's just not finished yet.
        if (videosCompleted === 0 && !videoInProgress) {
          report('skipped');
          continue;
        }
        report('done');
      }
    } catch (err) {
      console.warn('[run-cycle-debug] runAutomationCycle() channel try/catch caught an exception', channel?.id, err);
      console.error('[automationEngine] channel cycle failed', channel?.id, err);
      // A billing failure keeps its distinct status at the cycle level too, so the history table
      // shows "💳 credit exhausted" in amber rather than another generic red 'error' row.
      const status = isCreditExhaustedMessage(err?.message) ? 'credit_exhausted' : 'error';
      await logStep(channel?.id, null, 'cycle', status, String(err?.message || err));
      report('error');
    }
  }
  console.warn('[run-cycle-debug] runAutomationCycle() finished — all channels processed (or shouldStop() fired)');

  // Housekeeping, after the real work — real cycles only, throttled to ~once a day internally.
  if (!dryRun) await runDailyMediaCleanup(userId);
}
