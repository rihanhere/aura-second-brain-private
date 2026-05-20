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
- New GitHub branch pushed:
  - repo: `rihanhere/aura-second-brain-private`
  - branch: `codex/simple-brain-api-tts-20260521`
  - commit: `a0be260`
- New Render service created without touching the stable service:
  - service: `aura-api-simple-staging`
  - URL: `https://aura-api-simple-staging.onrender.com`
  - status: Live
- Render endpoint checks:
  - `/health`: pass.
  - `/tts/status`: pass; reports ElevenLabs unconfigured until secret env is set.
- Render deterministic `/capture` smoke:
  - `open github` -> honest unsupported reply.
  - `switch voice` -> honest unsupported reply.
  - `pause` -> `Okay.`
  - `remind me in 10 minutes...` -> real reminder object created.
  - `remember this...` -> durable memory save path returns confirmation.
  - simple normal-chat pattern checks pass.
- Render hardening suite:
  - `AURA_TEST_API_URL=https://aura-api-simple-staging.onrender.com npm run test:human-conversation`: pass in structure-mock mode.
- Render TTS missing-key behavior:
  - `/tts/elevenlabs/session` returns a clean `ElevenLabs TTS is not configured.` message until `ELEVENLABS_API_KEY` is set.

## Current Blockers

- Provider secrets are not yet configured on the new Render service.
- `/health` currently reports no brain provider keys and no voice provider keys.
- `/tts/status` currently reports `configured: false`.
- Full real LLM normal chat and ElevenLabs streaming cannot be certified until Render env secrets are added.
- IPA variants should not be built/frozen until the new Render service passes `/capture` and `/tts/status` with secrets configured.
- This current machine is not TESSERACT; the experimental IPA build script must run on TESSERACT or another machine with the iOS build environment and the experimental workspace.
- Do not put `ELEVENLABS_API_KEY` into mobile `.env` or source files.

## Next Required Steps

1. Add backend-only secret env vars directly in Render for `aura-api-simple-staging`:
   - `OPENROUTER_API_KEYS`
   - `GROQ_API_KEYS`
   - `GEMINI_API_KEYS`
   - `ELEVENLABS_API_KEY`
   - optional `ELEVENLABS_VOICE_ID`
2. Confirm non-secret env vars remain:
   - `AURA_SIMPLIFIED_BRAIN=1`
   - `AURA_ENV=simple-staging`
   - `HOST=0.0.0.0`
   - `ELEVENLABS_MODEL_ID=eleven_flash_v2_5`
   - `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`
   - `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=3`
3. Redeploy after env changes.
4. Verify:
   - `/health`
   - `/capture`
   - `/tts/status`
   - `/tts/elevenlabs/session`
5. Build variants on TESSERACT:
   - `AURA_SIMPLE_BACKEND_URL=https://aura-api-simple-staging.onrender.com scripts/build-experimental-api-tts-variants.sh`

## Protected Systems

Do not modify during this experiment unless a measured bug requires it:

- WhisperKit streaming STT
- VAD timing
- interruption/barge-in behavior
- launch/tap flow
- app session lifecycle
- stable beta source/IPA/backups
