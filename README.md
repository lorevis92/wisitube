# WisiTube — AI Faceless Video Studio

Part of the WiSiVERSE. Turn one topic into a complete animated faceless YouTube video:
script → voiceover → images → synced animation → timeline editing → WebM export + thumbnail + SEO pack.

## Architecture

| Piece | Tool | Cost |
|---|---|---|
| Script, titles, tags, thumbnail concepts | Anthropic API via `api/generate.js` (Vercel **Serverless** Function) | pennies per video |
| Images | Pollinations.ai (Flux) — anonymous free tier | free |
| Voiceover (TTS) | Pollinations.ai `openai-audio` (voices: nova, alloy, echo, fable, onyx, shimmer) | free |
| Animation + sync + export | Internal canvas engine (Ken Burns motion, crossfades, subtitles) + MediaRecorder → `.webm` | free, client-side |

Sync works by design: audio is generated per scene, so each scene's exact duration is known
and the animation switch happens precisely when the narration for that scene ends.

⚠️ `api/generate.js` is a **Serverless Function** (`handler(req, res)`, `maxDuration: 60`).
Never convert it to an Edge Function — the two signatures are incompatible.

## Setup (Windows / PowerShell — run commands one at a time)

```powershell
cd C:\Users\loren\Desktop\wisitube
npm install
```

Add the logos to `/public`:
- `logo-wisitube.png` (navbar)
- `logo-wisiverse.png` (footer, from Brand fotos)

Local dev (the `/api` proxy only runs under Vercel):

```powershell
npm i -g vercel
vercel dev
```

(`npm run dev` also works for pure UI work, but "Generate video plan" needs `vercel dev` or the deployed app.)

## Deploy

```powershell
git init
git add .
git commit -m "WisiTube v1"
git branch -M main
git remote add origin https://github.com/lorevis92/wisitube.git
git push -u origin main
```

Then on Vercel: import the repo and set the environment variable:

- `ANTHROPIC_API_KEY` = your Anthropic key

No Supabase needed for v1 (everything is in-browser). Supabase becomes useful later for
saving projects, user accounts, or a render history.

## Rate limits

Pollinations' anonymous tier has fair-use limits. The app already spaces requests (1.2s between scenes)
and retries. If a user hits limits anyway: Create → Advanced → paste a free token from enter.pollinations.ai
(stored in localStorage only).

## Known constraints (v1)

- Export renders in real time (a 60s video takes ~60s) and the tab must stay visible — browsers throttle hidden canvases.
- Output is `.webm` (YouTube accepts it). MP4 conversion via ffmpeg.wasm is a possible v2 feature.
- Best supported browser: Chrome/Edge desktop.
