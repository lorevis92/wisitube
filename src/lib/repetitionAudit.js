// One-shot anti-repetition editorial pass over a fully-written script.
//
// Run exactly once, after every scene of a video exists and BEFORE any media is generated (both
// recipes' scene→media boundary, and the manual flow's generateAllScenes→Storyboard boundary). It
// sends the assembled narration to api/generate-scenes.js (mode: 'repetition-audit') — a
// senior-editor prompt returns keep / delete / merge per scene — then applies the result to the
// built scene objects:
//   - "delete"  → the scene (and its image beats) is dropped entirely
//   - "merge"   → the scene collapses into the one its `mergeInto` names: that scene's narration
//                 becomes the combined text, and its visual beats are taken from whichever of the
//                 two scenes comes FIRST in the script
//   - "keep"    → left as-is, or with the lightly edited narration the model returned
//
// Never throws and never fails its caller. A network error, an unparsable response, or a result
// that would gut the whole script leaves `scenes` byte-for-byte as passed in (skipped: true).

const MIN_SCENES_TO_AUDIT = 4;

/**
 * @param {Array} scenes  built scene objects: { id, narration, images?: [...], ... }
 * @param {{ title?: string, language?: string }} opts
 * @returns {Promise<{ scenes: Array, summary: {before,after,removed,mergedPairs}|null, skipped: boolean, reason: string }>}
 */
export async function auditScriptRepetition(scenes, { title = '', language = 'English' } = {}) {
  const original = Array.isArray(scenes) ? scenes : [];
  const unchanged = (reason) => ({ scenes: original, summary: null, skipped: true, reason });

  if (original.length < MIN_SCENES_TO_AUDIT) return unchanged(`only ${original.length} scene(s) — not worth auditing`);

  let actions;
  try {
    const res = await fetch('/api/generate-scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'repetition-audit',
        title,
        language,
        scenes: original.map((s) => ({ sceneId: s.id, narration: s.narration || '' })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return unchanged(data.error || data.detail || `HTTP ${res.status}`);
    actions = Array.isArray(data.actions) ? data.actions : Array.isArray(data) ? data : null;
    if (!actions || actions.length === 0) return unchanged('response carried no actions');
  } catch (err) {
    return unchanged(String(err?.message || err));
  }

  let applied;
  try {
    applied = applyAudit(original, actions);
  } catch (err) {
    console.error('[repetitionAudit] could not apply the audit result — script kept as-is', err);
    return unchanged('could not apply the audit result');
  }

  // Guardrail: an audit that wipes out most of the script is far more likely a bad model response
  // than a genuinely all-redundant script. Refuse it rather than shipping a gutted video.
  const floor = Math.max(MIN_SCENES_TO_AUDIT, Math.ceil(original.length * 0.4));
  if (applied.scenes.length < floor) {
    return unchanged(`would have cut ${original.length} → ${applied.scenes.length} scenes — too aggressive, ignored`);
  }

  return {
    scenes: applied.scenes,
    summary: { before: original.length, after: applied.scenes.length, removed: applied.removed, mergedPairs: applied.merged },
    skipped: false,
    reason: '',
  };
}

// Human-readable one-liner for logs — "removed 4 scenes, merged 2 pairs — 48 → 41 scenes", or a
// clear skip reason. Shared by every call site so the wording stays identical everywhere.
export function describeAudit({ summary, skipped, reason }) {
  if (skipped || !summary) return `Repetition audit skipped (${reason || 'no changes possible'}) — script kept as-is`;
  if (!summary.removed && !summary.mergedPairs) return `Repetition audit: no repetition found — ${summary.before} scenes unchanged`;
  const parts = [];
  if (summary.removed) parts.push(`removed ${summary.removed} scene${summary.removed === 1 ? '' : 's'}`);
  if (summary.mergedPairs) parts.push(`merged ${summary.mergedPairs} pair${summary.mergedPairs === 1 ? '' : 's'}`);
  return `Repetition audit: ${parts.join(', ')} — ${summary.before} → ${summary.after} scenes`;
}

function applyAudit(scenes, actions) {
  const indexById = new Map(scenes.map((s, i) => [s.id, i]));
  const actionById = new Map();
  for (const a of actions) {
    if (a && actionMatchesAScene(a, indexById)) actionById.set(normalizeId(a.id, indexById), a);
  }

  const removeIds = new Set();
  const mergeTexts = new Map(); // targetId -> [combined narration strings]
  const mergeSources = new Map(); // targetId -> [sourceId]
  let removed = 0;
  let merged = 0;

  for (const s of scenes) {
    const a = actionById.get(s.id);
    if (!a) continue;
    if (a.action === 'delete') {
      removeIds.add(s.id);
      removed += 1;
    } else if (a.action === 'merge') {
      const target = normalizeId(a.mergeInto, indexById);
      const targetAction = actionById.get(target);
      // Fall back to "keep" when the target is missing, is this scene itself, or is itself being
      // removed (delete / merged away) — never drop content into a void.
      const targetGone = targetAction && (targetAction.action === 'delete' || targetAction.action === 'merge');
      if (target === undefined || !indexById.has(target) || target === s.id || targetGone) continue;
      removeIds.add(s.id);
      merged += 1;
      if (!mergeTexts.has(target)) mergeTexts.set(target, []);
      if (!mergeSources.has(target)) mergeSources.set(target, []);
      const combined = typeof a.narration === 'string' && a.narration.trim() ? a.narration.trim() : s.narration || '';
      mergeTexts.get(target).push(combined);
      mergeSources.get(target).push(s.id);
    }
  }

  const out = [];
  for (const s of scenes) {
    if (removeIds.has(s.id)) continue;
    let ns = s;
    const a = actionById.get(s.id);
    if (a && a.action === 'keep' && typeof a.narration === 'string' && a.narration.trim()) {
      ns = { ...ns, narration: a.narration.trim() };
    }
    if (mergeTexts.has(s.id)) {
      const texts = mergeTexts.get(s.id).filter(Boolean);
      const combinedNarration = texts.length ? texts.join(' ').trim() : ns.narration;
      // Visual beats from whichever of {this scene, its merge sources} comes first in the script.
      const sourceIds = mergeSources.get(s.id) || [];
      const earliestId = [s.id, ...sourceIds].reduce((best, id) => (indexById.get(id) < indexById.get(best) ? id : best), s.id);
      const earliest = scenes[indexById.get(earliestId)];
      ns = { ...ns, narration: combinedNarration };
      // Only for content types that HAVE image beats (full_pipeline). static_background scenes have
      // no `images` field at all — a merge there just combines the narration.
      if (Array.isArray(earliest.images)) ns.images = earliest.images.map((im) => ({ ...im }));
    }
    out.push(ns);
  }

  return { scenes: out, removed, merged };
}

// The model can echo ids back as strings ("12") even though the scenes carry numbers. Resolve an
// action's id to the real scene id it refers to.
function normalizeId(rawId, indexById) {
  if (indexById.has(rawId)) return rawId;
  const asNum = Number(rawId);
  if (Number.isFinite(asNum) && indexById.has(asNum)) return asNum;
  const asStr = String(rawId);
  for (const key of indexById.keys()) {
    if (String(key) === asStr) return key;
  }
  return undefined;
}

function actionMatchesAScene(a, indexById) {
  return normalizeId(a.id, indexById) !== undefined;
}
