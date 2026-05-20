# AURA Experimental Simple Brain + API TTS Handoff

Generated: 2026-05-21

## Baseline Protection

Stable beta remains untouched:

- `/Users/macos/Downloads/AURA-stable-beta-final-20260521`
- `/Users/macos/Downloads/Project AURA`
- `/Users/macos/Downloads/Project-AURA-organized-builds-20260521.zip`

Experimental workspace:

- `/Users/macos/Downloads/AURA-experimental-simple-brain-api-tts-20260521`

Supertonic assets were stripped only from the experimental workspace. The stable baseline still has local Supertonic.

## Implemented

- Simplified `/capture` path is enabled by default unless `AURA_SIMPLIFIED_BRAIN=0`.
- Normal chat now uses active-session context, current user message, runtime time, and a small Aura prompt.
- Passive emotional continuity, temporal cognition, memory governor hints, archive summaries, and pseudo-psychology are bypassed for normal chat.
- Explicit save, explicit recall, current-session recall, reminders, and deterministic time replies remain.
- Unsupported action requests stay honest.
- Added backend TTS proxy:
  - `GET /tts/status`
  - `POST /tts/elevenlabs/session`
  - `GET /tts/elevenlabs/session/:id/audio`
  - `POST /tts/elevenlabs/stream`
- ElevenLabs key stays backend-only.
- If `ELEVENLABS_VOICE_ID` is missing, the backend selects a default voice from the ElevenLabs account.
- Mobile TTS provider is controlled by `EXPO_PUBLIC_AURA_TTS_PROVIDER`:
  - `elevenlabs`: backend stream URL played by existing interruption-safe playback path.
  - `ios`: enhanced iOS Speech fallback only.
  - unset/`supertonic`: old Supertonic path, but experimental IPA builds should not use this after assets are stripped.
- Added variant build script:
  - `scripts/build-experimental-api-tts-variants.sh`

## Validation Completed

- `npm run build --workspace apps/api`: pass.
- `npm run typecheck --workspace apps/mobile`: pass.
- Local simplified capture smoke with structure mock: pass.
- `/tts/status`: pass; reports ElevenLabs unconfigured until backend env is set.

## Current Blockers

- New Render staging service is not deployed from this machine yet.
- TESSERACT has no configured `gh` or Render CLI and the project has no git remote.
- Do not put `ELEVENLABS_API_KEY` into mobile `.env` or source files.

## Next Required Steps

1. Create a new GitHub repo/branch or connect this experimental workspace to a deployable repo.
2. Create Render service `aura-api-simple-staging` from this workspace.
3. Add Render env vars:
   - `AURA_SIMPLIFIED_BRAIN=1`
   - `OPENROUTER_API_KEYS`
   - `GROQ_API_KEYS`
   - `GEMINI_API_KEYS`
   - `ELEVENLABS_API_KEY`
   - optional `ELEVENLABS_VOICE_ID`
4. Verify:
   - `/health`
   - `/capture`
   - `/tts/status`
   - `/tts/elevenlabs/session`
5. Build variants:
   - `AURA_SIMPLE_BACKEND_URL=https://aura-api-simple-staging.onrender.com scripts/build-experimental-api-tts-variants.sh`

## Protected Systems

Do not modify during this experiment unless a measured bug requires it:

- WhisperKit streaming STT
- VAD timing
- interruption/barge-in behavior
- launch/tap flow
- app session lifecycle
- stable beta source/IPA/backups
