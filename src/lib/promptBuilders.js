// Two prompt-building strategies for the two families of image models this app supports:
// - Pollinations (Flux/Kontext) works best with compact, unambiguous fragments — verbose or
//   flowery language dilutes the instruction and the style gets lost or ignored.
// - Nano Banana 2 / GPT Image 2 are large multimodal models that follow natural, discursive
//   instructions more reliably, and benefit from an explicit character name as a semantic anchor
//   rather than only a list of physical traits.

const TELEGRAPHIC_SUFFIX = ', no text, no letters, single coherent figure, correct anatomy';
const MAX_TELEGRAPHIC_LENGTH = 500;

// Fixed order: style first (so it isn't diluted/buried by everything after it), then the scene,
// then character traits, then the short fixed suffix. If the result is too long, only the
// character-traits segment is trimmed — style and scene are never touched.
export function buildTelegraphicPrompt({ scenePrompt, styleSuffix, characterTraits = '' }) {
  const build = (traits) => `${styleSuffix}. ${scenePrompt}${traits ? `, ${traits}` : ''}${TELEGRAPHIC_SUFFIX}`;

  let traits = characterTraits;
  let prompt = build(traits);
  if (prompt.length > MAX_TELEGRAPHIC_LENGTH && traits) {
    const overBy = prompt.length - MAX_TELEGRAPHIC_LENGTH;
    traits = traits.slice(0, Math.max(0, traits.length - overBy));
    prompt = build(traits);
  }
  return prompt;
}

// Full sentences, and — when a character bible character is present — its name used explicitly
// as a semantic anchor ("The character Napoleon...") rather than only a trait list, since these
// models associate named entities with strong visual priors far better than trait lists alone.
// A recognizable character's base_description is often deliberately minimal or empty (see the
// provider-aware note in api/generate-outline.js: the model already knows their appearance), so
// characterTraits may end up empty even though characterName is set — never drop the name in that
// case, it's the whole point of naming them instead of describing them.
export function buildNaturalLanguagePrompt({ scenePrompt, styleSuffix, characterName = '', characterTraits = '' }) {
  const parts = [`${scenePrompt}, illustrated in this visual style: ${styleSuffix}.`];

  if (characterName && characterTraits) {
    parts.push(`The character ${characterName} appears in this scene — depict them with these defining traits: ${characterTraits}.`);
  } else if (characterName) {
    parts.push(`The character ${characterName} appears in this scene, depicted as the model recognizes them.`);
  } else if (characterTraits) {
    parts.push(`The main character in this scene has these defining traits: ${characterTraits}.`);
  }

  parts.push(
    'The figure must be anatomically correct, with a single coherent body and the correct number of limbs and fingers. Do not include any text, letters, or words in the image.'
  );

  return parts.join(' ');
}
