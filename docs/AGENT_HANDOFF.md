# AURA Agent Handoff

Last updated: 2026-05-16

This is the read-this-first file for any agent or developer continuing AURA. It explains what exists now, why it was built this way, what must not be broken, and how to run/debug/build the project.

## Current Goal

AURA is a voice-first AI life journal and companion. The core magic is not just chat. The core magic is long-term memory: AURA should quietly remember conversations, facts, dates, reminders, patterns, emotional continuity, and be able to recall them naturally later.

The current app is a local prototype:

- Mobile app: Expo/React Native iOS app.
- Backend: local Node/Express server on the Mac.
- iPhone connects to backend at `http://192.168.1.7:4000`.
- Backend orchestrates STT, LLM, TTS, memory, reminders, check-ins, and recall.

## Repository

Root:

```text
/Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
```

Main workspaces:

```text
apps/api      Backend API
apps/mobile   Expo React Native iOS app
docs          Product docs, PDFs, handoff docs
scripts       IPA build scripts
```

Important generated docs:

```text
docs/AURA_Product_Memory_Vision.pdf
docs/AURA_Future_Launch_Plan.pdf
docs/AGENT_HANDOFF.md
```

## Run Commands

Start backend:

```zsh
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second && npm run dev --workspace apps/api
```

Restart backend:

```zsh
lsof -ti tcp:4000 | xargs kill -9 2>/dev/null; cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second && npm run dev --workspace apps/api
```

Health checks:

```zsh
curl http://127.0.0.1:4000/health
curl http://192.168.1.7:4000/health
```

Typecheck:

```zsh
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second && npm run typecheck --workspaces --if-present
```

Build API:

```zsh
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second && npm run build --workspace apps/api
```

Brain Lab evaluation:

```zsh
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
npm run beta:real-user -- --stage=single
npm run beta:real-user -- --stage=100 --mode=mixed --real-users=15 --llm-max-calls=600 --replay-cache=write
npm run beta:real-user -- --stage=100 --mode=mixed --real-users=15 --llm-max-calls=600 --replay-cache=read
npm run beta:real-user -- --stage=1000 --mode=structure
npm run beta:real-user -- --stage=1000 --mode=sampled --critical-only=true --llm-max-calls=300
npm run beta:real-user -- --stage=100 --mode=mixed --failure-profile=medium --llm-max-calls=300
```

IPA build, usually on the other Mac:

```zsh
cd ~/Downloads/build-a-mobile-application-called-second && npm install && npm run ipa:ios 2>&1 | tee aura-build.log
```

## Backend Status

Backend entrypoint:

```text
apps/api/src/index.ts
```

It uses:

- `express`
- `helmet`
- `cors`
- `multer`
- `tsx watch`
- local JSON persistence if Supabase is not configured

Server bind:

```ts
app.listen(env.port, env.host)
```

`env.host` defaults to:

```text
0.0.0.0
```

This is important. Do not change it back to localhost. Physical iPhone needs LAN access.

Main backend routes:

```text
GET    /health
POST   /capture
POST   /voice/transcribe
POST   /voice/synthesize
GET    /memories
POST   /memories/session/finalize
GET    /reminders
POST   /reminders
DELETE /reminders/:id
GET    /insights
POST   /keys/validate
```

Backend health currently reports provider status for:

- OpenRouter brain
- Groq transcription
- Gemini TTS
- Pocket TTS fallback
- Memory store
- Conversation archive

## AURA Brain Lab

The current repo includes a cost-safe backend evaluation framework called Brain Lab:

```text
scripts/aura-real-user-simulation.mjs
npm run beta:real-user
```

Purpose:

- test whether AURA replies naturally
- test memory routing and recall correctness
- test cross-user memory isolation
- test drift after many users
- test backend latency budgets
- test cost risk without full LLM burn
- test failure injection without touching real users

Stages:

```text
single   1 fake user x 40 messages, real LLM behavior audit
100      100 fake users x 40 messages, mixed real/mock mode
1000     1000 fake users x 40 messages, structure/mock or sampled mode
```

Important modes:

```text
--mode=mixed       100-user distribution test with selected real-LLM users
--mode=structure   zero external AI calls; tests scale, routing, memory, reminders
--mode=sampled     tiny critical-path real LLM sample under scale
```

Cost controls:

- `--llm-max-calls` is the hard cap. It is more important than percentage.
- `--llm-sample` only decides eligibility.
- `--real-users=15` means selected full-LLM users in the 100-user mixed test.
- `--critical-only=true` samples only goal recall, relationship recall, pattern recall, and emotional-support paths.

Replay cache:

```zsh
npm run beta:real-user -- --stage=100 --mode=mixed --real-users=15 --llm-max-calls=600 --replay-cache=write
npm run beta:real-user -- --stage=100 --mode=mixed --real-users=15 --llm-max-calls=600 --replay-cache=read
```

The replay cache stores normalized mock replies so regression runs are repeatable. Cache misses fall back to deterministic mock unless `--allow-cache-miss-llm=true` is explicitly passed.

Failure injection:

```zsh
npm run beta:real-user -- --stage=100 --mode=mixed --failure-profile=medium --llm-max-calls=300
```

Failure profiles use test-only chaos headers for fake users only. They can inject brain delay, brain failure, and memory delay while voice remains disabled.

Latest smoke verification:

```text
100 mixed smoke: pass, 2 real calls / 18 theoretical, voice jobs 0
replay read smoke: pass, 31 replay hits / 0 misses
1000 structure smoke: pass, 0 real LLM calls, voice jobs 0
failure injection smoke: pass, degradation shape "smooth slowdown"
```

Report paths:

```text
/tmp/aura-real-user-simulation/single-report.md
/tmp/aura-real-user-simulation/100-users-report.md
/tmp/aura-real-user-simulation/1000-users-report.md
/tmp/aura-real-user-simulation/*.json
```

Hard fail rules:

- any cross-user memory leak
- backend crash
- uncontrolled queue growth
- real LLM calls exceeding the cap
- voice jobs triggered during no-voice tests
- recall score below threshold
- router catastrophic mismatch

## Environment

Backend env file:

```text
apps/api/.env
```

Do not paste secrets into docs. This file contains real keys and should stay local/private.

Important variables:

```text
HOST=0.0.0.0
PORT=4000
OPENROUTER_API_KEYS=...
OPENROUTER_MODEL=z-ai/glm-4.5-air:free
OPENROUTER_FALLBACK_MODELS=google/gemini-flash-1.5,anthropic/claude-3.5-haiku
GROQ_API_KEYS=...
GEMINI_API_KEYS=...
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts
GEMINI_TTS_VOICE=Sulafat
POCKET_TTS_ENABLED=true
POCKET_TTS_COMMAND=uvx
POCKET_TTS_COMMAND_ARGS=pocket-tts,generate
POCKET_TTS_LANGUAGE=english
POCKET_TTS_DEVICE=cpu
POCKET_TTS_TIMEOUT_MS=8500
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
GEMINI_EMBEDDING_DIMENSIONS=1536
BETA_DAILY_MESSAGE_LIMIT=15
```

## Mobile Status

Mobile app:

```text
apps/mobile
```

Main files:

```text
apps/mobile/src/App.tsx
apps/mobile/src/screens/CaptureScreen.tsx
apps/mobile/src/lib/api.ts
apps/mobile/src/lib/audio.ts
apps/mobile/src/lib/reminderScheduler.ts
apps/mobile/src/components/AuraOrb.tsx
apps/mobile/src/components/AuraWordmark.tsx
apps/mobile/src/components/DrawerMenu.tsx
```

Bundle id:

```text
ai.aura.journal.recall
```

Mobile API target:

```ts
const LAN_API_URL = "http://192.168.1.7:4000";
```

This is in:

```text
apps/mobile/src/lib/api.ts
```

Important: the app should never fall back to `localhost` for physical iPhone testing.

## iOS Network Requirements

The iOS app needs local-network/HTTP allowances because the backend is local HTTP:

- `NSLocalNetworkUsageDescription`
- ATS local HTTP allowance
- microphone permissions

These are configured through Expo/native prebuild config. If networking suddenly fails on iPhone but Safari can open `/health`, inspect:

```text
apps/mobile/app.json
apps/mobile/ios/AURA/Info.plist
apps/mobile/src/lib/api.ts
```

## Core User Flow

Voice flow:

```text
Tap
-> app starts recording
-> UI shows Listening
Tap again
-> recording stops
-> UI shows Thinking
-> /voice/transcribe sends .m4a to Groq Whisper
-> /capture sends transcript to backend
-> backend saves raw user turn
-> backend analyzes memory/reminder/check-in/recall intent
-> backend calls OpenRouter unless deterministic reply/reminder/recall takes precedence
-> backend saves assistant turn
-> backend returns reply + optional voice
-> app shows reply text
-> app plays Gemini voice, then Pocket/iOS fallback if needed
```

Type flow:

```text
Type Instead screen
-> /capture
-> same backend memory/reply/voice logic
```

## Capture Route

The central route is:

```text
apps/api/src/routes/capture.ts
```

It does most of AURA's intelligence work:

1. Parse content/inputMode/timezone.
2. Detect pending check-in answer.
3. Analyze memory.
4. Infer tool intent, especially reminders.
5. Create embedding if memory should store.
6. Save raw user conversation turn.
7. Save smart memory if relevant.
8. Create reminder if reminder intent exists.
9. Build memory context.
10. Build exact archive recall context.
11. Decide recall mode: `utility` or `companion`.
12. Derive emotional continuity.
13. Build companion continuity context.
14. Use deterministic replies for greetings/capability/listening.
15. Use OpenRouter for normal brain replies.
16. Override with deterministic archive answer for exact date recall.
17. Override with explicit save acknowledgement when user says save/remember.
18. Strip unwanted "saved" wording from normal replies.
19. Save assistant turn.
20. Synthesize voice.
21. Return reply, memory, reminder, archive metadata, and voice.

Critical invariant: reminder intent beats memory recall. A message like "remind me to drink water after two minutes" must create a reminder, not answer from memory.

## Brain / OpenRouter

OpenRouter service:

```text
apps/api/src/services/openRouter.ts
```

Current primary model:

```text
z-ai/glm-4.5-air:free
```

Fallback models:

```text
google/gemini-flash-1.5
anthropic/claude-3.5-haiku
```

Important behavior:

- Multiple OpenRouter keys rotate.
- Empty/generic weak replies should be treated as failures and retried.
- Deterministic small-talk replies exist so "hello" does not become "I hear you, I am here with you."
- If OpenRouter fails, the app should not crash or infinite-load.

## Voice System

Backend voice:

```text
apps/api/src/services/geminiVoice.ts
apps/api/src/services/pocketTts.ts
apps/api/src/routes/voice.ts
```

Voice hierarchy:

1. Gemini TTS: premium voice.
2. Pocket TTS: quota-free fallback.
3. iOS speech: emergency on-device fallback.

Backend endpoint:

```text
POST /voice/synthesize
```

Input:

```json
{ "text": "Hey Rihan, time to drink water." }
```

Output:

```json
{ "voice": { "audioBase64": "...", "provider": "gemini|pocket-tts", "model": "..." } }
```

or:

```json
{ "voice": null }
```

Normal chat `/capture` also returns `voice`.

Mobile audio:

```text
apps/mobile/src/lib/audio.ts
```

Important functions:

- `playPcmBase64`: writes base64 PCM/WAV into cache and plays through `expo-av`.
- `speakTextWithFailsafe`: iOS fallback voice, louder than earlier builds, with timeout and voice selection.
- `preparePlaybackAudioMode`: enables playback in silent mode.

Do not regress fallback volume. Current fallback uses:

```ts
volume: 1
rate: 1.08
pitch: 1.02
playsInSilentModeIOS: true
```

## Transcription

Route:

```text
POST /voice/transcribe
```

Backend:

```text
apps/api/src/routes/voice.ts
apps/api/src/services/transcription.ts
```

Mobile:

```text
apps/mobile/src/lib/api.ts
```

Important details:

- App records `.m4a`.
- Upload uses `FormData` with:

```ts
{ uri, name: "aura-voice.m4a", type: "audio/m4a" }
```

- Before upload, app probes `/health`.
- Backend logs multipart file presence, size, mimetype, and transcript result.

## Memory System

This is AURA's most important system.

There are multiple layers, and they should stay separate:

### 1. Raw Conversation Archive

File/service:

```text
apps/api/src/services/conversationArchive.ts
apps/api/data/conversation-archive.json
```

Stores every user turn and every assistant turn:

- id
- user_id
- role
- content
- input_mode
- timezone
- session_id
- searchable_text
- metadata
- created_at

This is the source of truth for exact historical recall.

### 2. Smart Memories

File/service:

```text
apps/api/src/services/memoryStore.ts
apps/api/src/services/memoryAnalyzer.ts
apps/api/data/local-memories.json
```

Stores extracted/summarized memory:

- summary
- emotional_state
- goals
- action_items
- important_facts
- recurring_topics
- habits
- priorities
- auto_tags
- importance
- memory_layer
- embedding if available

If Supabase is not configured, local JSON storage is used.

### 3. Session Summaries

Handled in:

```text
apps/api/src/services/memoryStore.ts
```

Idle summarization runs after about five minutes of inactivity. It creates compact session summaries so AURA can recall old conversations faster and with less prompt load.

### 4. Emotional Continuity

File/service:

```text
apps/api/src/services/emotionalContinuity.ts
apps/api/data/emotional-signals.json
apps/api/data/memory-theme-scores.json
apps/api/data/relationship-continuity.json
```

This is a derived layer, not historical truth.

It tracks:

- emotional signals like tired, stressed, sad, excited, calm, motivated
- recurring themes like sleep, work, family, fitness, trading, money, weed, app, memory
- relationship mentions like dad, mother, friend, girlfriend, cofounder
- mention counts
- intensity
- current polarity
- unresolved topics

It is designed to make AURA feel like a continuous companion without dumping timestamps every turn.

### 5. Exact Date-wise Recall

Handled by:

```text
apps/api/src/services/conversationArchive.ts
```

Supported recall examples:

- "what did I say today?"
- "what did I say yesterday?"
- "what did we talk about last week?"
- "what did I say on May 14?"
- "what did I say one year ago?"

Utility recall mode returns timestamped archive answers.

Companion mode should not dump timestamps. It should say things naturally, like:

```text
You've seemed worn out lately.
Work has come up a few times.
You mentioned this before.
```

## Recall Modes

The backend decides between:

```text
utility
companion
```

Utility mode:

- exact recall
- reminders
- save commands
- date/history questions
- deterministic output

Companion mode:

- normal chat
- emotional continuity
- subtle memory context
- no timestamp dumps unless asked

Important UX rule: AURA should not constantly prove it remembers things. Memory should be useful and subtle.

## Reminders

Backend:

```text
apps/api/src/services/reminderParser.ts
apps/api/src/services/reminderStore.ts
apps/api/src/routes/reminders.ts
```

Mobile:

```text
apps/mobile/src/lib/reminderScheduler.ts
apps/mobile/src/App.tsx
apps/mobile/src/screens/RemindersScreen.tsx
```

Reminder types:

- simple reminder
- check-in reminder
- recurrence for minute/hour intervals

Supported language examples:

- "remind me to drink water after two minutes"
- "remind me at 7:30 PM to call..."
- "ask me if I am still smoking weed after 30 minutes"
- "every 2 hours"

Current behavior:

- Backend creates reminder drafts.
- Mobile schedules iOS local notification for background/closed app.
- If app is foreground at due time, foreground reminder engine speaks it and shows the reminder text like a reply.
- If app is background/closed, normal iOS AURA text notification appears.
- No custom voice notification in background. Voice in background is not promised.

Foreground reminder voice flow:

1. Detect due local reminder every second.
2. If app active and voice not busy, prepare voice before making text visible.
3. Try `/voice/synthesize`.
4. Play Gemini/Pocket voice if available.
5. Fall back to iOS speech.
6. Mark reminder delivered/completed.

Critical mobile constants in `App.tsx`:

```ts
REMINDER_GEMINI_TIMEOUT_MS = 9000
REMINDER_MAX_VOICE_WAIT_MS = 59000
VOICE_BUSY_STALE_MS = 20 * 1000
```

The "wait until end of scheduled minute" behavior exists so reminder text and voice can appear together as much as possible.

## Check-ins

Check-ins are reminders with self-improvement behavior.

Example:

```text
ask me if I'm still smoking weed after 30 minutes
```

At due time:

- foreground: AURA asks by voice
- background: normal notification asks
- user response goes through `/capture` as `pendingCheckIn`
- backend detects yes/no/unclear
- answer is saved into memory/archive
- AURA responds supportively, not shamefully

Current yes response:

```text
You started around the time you asked me to check in. Try not to add more right now. Drink some water, settle in, and do something you actually enjoy while this passes.
```

Current no response:

```text
Good. Keep that promise to yourself for a little longer. Let the urge pass, drink some water, and do something calm for the next few minutes.
```

## UI State

The approved UI direction is minimal, white/grey, premium, calm.

Important UI assets:

```text
apps/mobile/assets/aura-fluid-orb-transparent.png
apps/mobile/assets/aura-fluid-orb.jpeg
apps/mobile/preview/aura-webgl-preview.html
```

Important components:

```text
apps/mobile/src/components/AuraOrb.tsx
apps/mobile/src/components/AuraWordmark.tsx
apps/mobile/src/screens/LaunchScreen.tsx
apps/mobile/src/screens/CaptureScreen.tsx
```

Design principles:

- white/grey premium background
- no clutter
- orb should feel alive
- AURA wordmark uses stylized A
- listening/thinking/reply text is muted grey/black, not bright blue
- no extra reply card rectangle
- reply appears directly on background
- menu/type buttons should be minimal and appear as needed

Known UI experiments happened in parallel. Preserve backend and memory behavior first; UI changes must not break tap/listen/think/reply.

## Drawer / Navigation

Drawer routes are defined by:

```text
apps/mobile/src/components/DrawerMenu.tsx
```

Routes currently include:

- home
- journal/memory
- reminders
- insights
- you/profile
- settings
- type instead

`ApiKeysScreen` and onboarding files exist, but current product decision is not to force BYOK onboarding yet. Backend uses env keys.

## Provider Keys

Provider override headers exist:

```text
x-aura-openrouter-keys
x-aura-groq-key
x-aura-groq-keys
x-aura-gemini-keys
```

Do not log secrets. Request logging currently logs request metadata, not key values.

## Local Persistence Files

Backend local data is under:

```text
apps/api/data/
```

Important files:

```text
conversation-archive.json
local-memories.json
emotional-signals.json
memory-theme-scores.json
relationship-continuity.json
```

These are valuable for local testing. Do not delete them casually.

## Supabase

Supabase support exists, but current health says local-file persistence if Supabase env is not configured.

Production direction:

- Supabase Postgres for memory/archive/reminders.
- Local JSON is acceptable for current personal Mac-hosted prototype.

## PDFs and Documentation

Product/memory PDF:

```text
docs/aura-product-memory-vision.html
docs/AURA_Product_Memory_Vision.pdf
```

Future launch PDF:

```text
docs/aura-future-launch-plan.html
docs/AURA_Future_Launch_Plan.pdf
```

Both PDFs were uploaded to Google Drive folder `MacTransfer`.

## Notes App

An Apple Notes note named `AURA Backend Commands` was created with:

- start backend command
- restart backend command
- health check command
- iPhone health URL

## AirDrop / Computer Use Notes

Computer Use had issues because stale Computer Use MCP helper processes were running. Restarting the helper fixed it.

Useful diagnosis:

```zsh
ps aux | egrep -i 'SkyComputerUse(Client|Service)' | grep -v egrep
```

Computer Use permissions needed:

- Accessibility for Codex
- Screen Recording for Codex
- Automation permissions for Finder/System Events

AirDrop to iPhone failed because the AirDrop picker said `No People Found`. This means iPhone was not discoverable at that moment. It was not a code problem.

## Build / Copy Handoff Skill

Existing skill:

```text
/Users/rihan/.codex/skills/aura-airdrop-ipa-handoff/SKILL.md
```

It documents the repeatable flow:

1. Create full zip of the project.
2. Move old zips/folders into `pre builds`.
3. AirDrop zip to TESSERACT.
4. Unzip on TESSERACT.
5. Run IPA build command.

Do not create tiny stripped zips for build handoff.

## Important Do Not Break Rules

1. Do not change backend host from `0.0.0.0`.
2. Do not make iPhone use `localhost`.
3. Do not remove ATS/local network iOS permissions.
4. Do not remove local JSON persistence.
5. Do not collapse raw archive and smart memory into one store.
6. Do not let reminder intent become memory recall.
7. Do not spam "saved" messages in normal chat.
8. Do not make background voice notification promises.
9. Do not make Gemini TTS required for reminders; Pocket/iOS fallback must stay.
10. Do not log API keys.
11. Do not rebuild IPA blindly without checking backend URL and Info.plist/network config.
12. Do not delete `apps/api/data` unless user explicitly asks.

## Known Issues / Watch List

- Google Drive local folders are blocked from terminal by macOS privacy, so use Safari/Drive UI if needed.
- AirDrop needs iPhone discoverability; if AirDrop says `No People Found`, fix iPhone settings, not code.
- OpenRouter free models may rate-limit or return weak replies. Key rotation helps, but fallback logic must remain strict.
- Gemini TTS may hit quota. Pocket TTS is the reliable fallback.
- iOS fallback speech can sound robotic; keep it loud and only as emergency fallback.
- Background/closed-app reminders use text notifications only.
- Foreground reminders require an IPA with the latest reminder voice patch.
- Current backend is Mac-hosted; app only works while Mac backend is running and iPhone is on the same network.

## Future Launch Direction

See:

```text
docs/AURA_Future_Launch_Plan.pdf
```

Short version:

- Keep Mac backend for personal testing now.
- Deploy backend to always-on host for real beta.
- Use public HTTPS URL instead of LAN IP.
- Use Supabase for persistent user memory.
- Keep provider keys on backend.
- Consider BYOK later, but do not force it in the current personal build.
- Start with TestFlight private beta.

## Quick Debug Recipes

Backend unreachable on iPhone:

```zsh
curl http://127.0.0.1:4000/health
curl http://192.168.1.7:4000/health
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

If Mac health works but iPhone fails:

- confirm same Wi-Fi
- confirm Mac IP is still `192.168.1.7`
- confirm iPhone Safari opens `http://192.168.1.7:4000/health`
- inspect `apps/mobile/src/lib/api.ts`
- inspect iOS ATS/local network keys

Voice not playing:

- Check `/health` voice provider status.
- Gemini active keys may be exhausted.
- Test `/voice/synthesize`.
- Pocket TTS should provide fallback.
- On mobile, check `playPcmBase64` and `speakTextWithFailsafe`.

Reminder not firing:

- Confirm reminder exists in local mobile cache/Reminders screen.
- Confirm notification permission.
- Foreground reminder depends on `processDueReminders` in `App.tsx`.
- Background notification is scheduled by `expo-notifications`.
- If app is foreground, banner is intentionally suppressed and voice/text should appear in app.

Memory recall wrong:

- Check `conversation-archive.json` first.
- Then check `local-memories.json`.
- Exact date recall comes from archive, not smart memories.
- Companion emotional continuity should not override utility recall.

## What Was Built Recently

Recent major work:

- Hardened backend LAN connectivity and `/health`.
- Fixed iPhone local backend networking assumptions.
- Added raw conversation archive.
- Added exact date-wise recall.
- Added silent memory save and explicit save acknowledgement.
- Added session summaries after idle gaps.
- Added emotional continuity layer.
- Added relationship/person continuity records.
- Added reminder/check-in parsing and storage.
- Added foreground reminder voice behavior.
- Added background text notification scheduling.
- Added `/voice/synthesize`.
- Added Gemini TTS fallback to Pocket TTS.
- Strengthened iOS speech fallback volume/rate.
- Tightened repetitive "I hear you" reply behavior.
- Added Brain Lab real-user simulation with LLM caps, replay cache, structure mode, sampled mode, and failure injection.
- Created product/memory PDF.
- Created future launch PDF.
- Uploaded both PDFs to Google Drive `MacTransfer`.
- Created Apple Notes backend command note.

## Current Mental Model

AURA is three systems working together:

1. **Utility system**
   - exact history
   - reminders
   - date recall
   - save commands
   - deterministic behavior

2. **Companion system**
   - normal chat
   - warm replies
   - subtle memory continuity
   - emotional patterns
   - restraint

3. **Voice system**
   - tap/listen/think/reply
   - STT through Groq
   - LLM through OpenRouter
   - TTS through Gemini/Pocket/iOS

The most important product principle is restraint: AURA should remember everything, but should not constantly announce that it remembers everything.
