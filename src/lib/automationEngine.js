// Multi-channel automation engine. Phase 1 shipped the cycle loop, its safety caps, and its
// observability in dry-run mode only. Phase 2a wires getRecipeForContentType's 'full_pipeline' id
// to the real titles → outline → scenes → media → render → thumbnail → YouTube pipeline
// (src/lib/recipes/fullPipelineRecipe.js) — real generation, real spend, real publishing, but
// still only ever started manually from AutomationStep.jsx (no auto-start; that's Phase 2b).
import { saveChannel, listChannels, logAutomationStep } from './db';
import { priceForImage } from './imageProviders';
import { priceForVoice } from './voiceProviders';
import { runFullPipeline } from './recipes/fullPipelineRecipe';

const PAID_IMAGE_PROVIDERS = ['nanobanana', 'gptimage', 'nanobanana-batch'];
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

// Recipe registry — returns the actual pipeline function for a content type, or null if none
// exists yet (not an error: getRecipeForContentType(null) is how "no recipe available for this
// content type" is represented to the caller, see runAutomationCycle below).
export function getRecipeForContentType(contentType) {
  switch (contentType) {
    case 'full_pipeline':
      return runFullPipeline;
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
  const lengthMinutes = Number(channel.automation_length_minutes) || 5;
  const totalScenes = Math.max(6, Math.round(lengthMinutes * 12));
  const beats = totalScenes * 2;
  const provider = channel.automation_image_provider || 'pollinations';
  const voiceEngine = channel.automation_voice_engine || 'kokoro';

  const imageTotal = beats * priceForImage(provider, { width: 1280, height: 720, quality: 'medium', hasReference: false });
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
        report('done');
      } else {
        // Exhaust this channel's daily quota before moving on to the next channel: keep generating
        // videos on it until canRunChannelToday says no (upload cap reached or budget exhausted) or
        // the caller asks to stop — not just one video then straight to the next channel. `channel`
        // is reassigned to saveChannel's own return after every video, since
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
          // eslint-disable-next-line no-await-in-loop
          const result = await recipe(channel, {
            userId,
            logStep,
            onProgress: (evt) => onProgress?.({ channelId: channel.id, channelName: channel.name, ...evt }),
          });

          if (result.inProgress) {
            // Gemini Batch jobs are still running for this video (see fullPipelineRecipe.js's
            // media phase) — nothing failed, there's just nothing left to do until Google
            // finishes them. Spend so far is real and counted; the upload count is not, since no
            // video was actually produced yet. Stops the exhaustion loop for this channel this
            // cycle rather than starting ANOTHER new video on top of the one still in flight —
            // it'll be picked up (resumed) automatically on a later cycle.
            // eslint-disable-next-line no-await-in-loop
            channel = await saveChannel({
              ...channel,
              automation_daily_spend_usd: (Number(channel.automation_daily_spend_usd) || 0) + (result.costUsd || 0),
            });
            videoInProgress = true;
            // eslint-disable-next-line no-await-in-loop
            await logStep(channel.id, result.videoId, 'cycle', 'pending', 'video still in progress (Gemini Batch jobs running) — will resume next cycle');
            break;
          }

          // A failed run never reaches here (the recipe throws, caught below) — so the upload
          // count only ever increments for a video that actually finished and published.
          // eslint-disable-next-line no-await-in-loop
          channel = await saveChannel({
            ...channel,
            automation_daily_upload_count: (Number(channel.automation_daily_upload_count) || 0) + 1,
            automation_daily_spend_usd: (Number(channel.automation_daily_spend_usd) || 0) + (result.costUsd || 0),
          });
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
      console.error('[automationEngine] channel cycle failed', channel?.id, err);
      await logStep(channel?.id, null, 'cycle', 'error', String(err?.message || err));
      report('error');
    }
  }
}
