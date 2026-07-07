// Shared voice-provider config — mirrors imageProviders.js. Kokoro (src/lib/tts.js) runs entirely
// locally in the browser and is always free; MiniMax Speech-02 HD is a paid cloud engine routed
// through fal.ai, billed per 1000 characters of narration.

export const VOICE_ENGINE_LABELS = {
  kokoro: 'Kokoro (Free, local)',
  minimax: 'MiniMax HD (~$0.10/1K characters, cloud)',
};

const MINIMAX_PRICE_PER_1K_CHARS = 0.1;

// Same rounding the server uses (api/generate-audio.js) so the client-side pre-generation
// estimate always matches what will actually be billed, never just an approximation of it.
export function priceForVoice(engine, charCount) {
  if (engine !== 'minimax') return 0;
  return Math.ceil((charCount / 1000) * MINIMAX_PRICE_PER_1K_CHARS * 100) / 100;
}

// A curated set of MiniMax's built-in system voices. These aren't language-locked — each one can
// narrate any of the app's supported languages via the language_boost parameter — so the same
// list applies regardless of narration language.
export const MINIMAX_VOICES = [
  { id: 'Wise_Woman', label: 'Wise Woman' },
  { id: 'Friendly_Person', label: 'Friendly Person' },
  { id: 'Deep_Voice_Man', label: 'Deep Voice Man' },
  { id: 'Calm_Woman', label: 'Calm Woman' },
  { id: 'Casual_Guy', label: 'Casual Guy' },
  { id: 'Lively_Girl', label: 'Lively Girl' },
  { id: 'Patient_Man', label: 'Patient Man' },
  { id: 'Determined_Man', label: 'Determined Man' },
  { id: 'Elegant_Man', label: 'Elegant Man' },
  { id: 'Inspirational_girl', label: 'Inspirational Girl' },
];
