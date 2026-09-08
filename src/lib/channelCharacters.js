// Channel-level recurring characters.
//
// A channel can define characters (name + description + optional reference photo) that recur across
// many of its videos — a fixed narrator, a mascot, a historical figure the channel keeps covering.
// They're stored on wisitube_channels.channel_characters (see db.js) and edited in
// ChannelDashboardStep.jsx. This module is the single place that
//   (a) shapes them for the /api/generate-outline request body, and
//   (b) merges them into a video's freshly-generated character bible + reference list once the
//       outline returns
// so the manual flow (App.jsx handleOutlineReady), fullPipelineRecipe.js and staticBackgroundRecipe.js
// all treat them identically.

import { downloadMediaAsBlob } from './mediaStorage';

function slugifyName(name) {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'character';
}

// Stable id for a channel character — its saved id if it has one, otherwise derived from the name.
// The "chc_" prefix keeps a name-derived id from colliding with a model-authored one ("char_...").
export function channelCharacterId(c) {
  return typeof c?.id === 'string' && c.id.trim() ? c.id.trim() : `chc_${slugifyName(c?.name)}`;
}

// Reference-photo id for a channel character's photo — namespaced so it can't collide with a
// per-video reference id (crypto.randomUUID) or a character id.
function channelCharacterRefId(id) {
  return `chref_${id}`;
}

// Metadata for the /api/generate-outline request body (`channelCharacters`). No blobs — the outline
// model only ever needs id / name / description / whether a photo exists.
export function channelCharactersForPrompt(channel) {
  const list = Array.isArray(channel?.channel_characters) ? channel.channel_characters : [];
  return list
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({
      id: channelCharacterId(c),
      name: c.name.trim(),
      description: typeof c.description === 'string' ? c.description.trim() : '',
      hasPhoto: !!c.photoStoragePath,
    }));
}

// Reference-list stubs ({ id, label }) for the channel characters that carry a photo — appended to
// the `references` array sent to /api/generate-outline (and later /api/generate-scenes) so the model
// can anchor a scene beat to the photo via reference_id, exactly like a manually-uploaded reference.
// The ids match what mergeChannelCharacters writes into project.references.
export function channelCharacterReferenceStubs(channel) {
  const list = Array.isArray(channel?.channel_characters) ? channel.channel_characters : [];
  return list
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() && c.photoStoragePath)
    .map((c) => ({ id: channelCharacterRefId(channelCharacterId(c)), label: c.name.trim() }));
}

/**
 * Merges a channel's recurring characters into a video's freshly-generated character bible and
 * reference list. Never throws — a channel character that can't be resolved is skipped and the video
 * still generates. Returns { characterBible, references } (new arrays; inputs untouched).
 *
 * - characterBible entries use the { id, name, baseDescription, variants } shape the rest of the app
 *   uses. A channel character the model already included (matched by id OR case-insensitive name) is
 *   left exactly as the model wrote it — it was told to keep the id/name, and its variants may carry
 *   story-specific era/costume detail worth keeping. Only genuinely-absent ones are appended, so a
 *   new video-specific character never conflicts with a channel one.
 * - references get one entry per channel character that has a photo:
 *   { id, label, storagePath, file } — `file` downloaded here best-effort so first-run image
 *   generation has the blob; `storagePath` kept so a resumed session re-downloads it via
 *   rehydrateProjectMedia, same as a manually-uploaded reference.
 */
export async function mergeChannelCharacters(channel, characterBible, references) {
  const chars = Array.isArray(channel?.channel_characters) ? channel.channel_characters : [];
  const bible = Array.isArray(characterBible) ? [...characterBible] : [];
  const refs = Array.isArray(references) ? [...references] : [];
  if (!chars.length) return { characterBible: bible, references: refs };

  for (const raw of chars) {
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const id = channelCharacterId(raw);
    const name = raw.name.trim();
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';

    const nameLower = name.toLowerCase();
    const already = bible.find(
      (c) => c && ((c.id && c.id === id) || (typeof c.name === 'string' && c.name.trim().toLowerCase() === nameLower))
    );
    if (!already) {
      bible.push({ id, name, baseDescription: description, variants: [], fromChannel: true });
    }

    if (raw.photoStoragePath) {
      const refId = channelCharacterRefId(id);
      if (!refs.some((r) => r && r.id === refId)) {
        let file = null;
        try {
          file = await downloadMediaAsBlob(raw.photoStoragePath);
        } catch (err) {
          console.error('[channelCharacters] could not download channel character photo', raw.photoStoragePath, err);
        }
        refs.push({ id: refId, label: name, storagePath: raw.photoStoragePath, file });
      }
    }
  }

  return { characterBible: bible, references: refs };
}
