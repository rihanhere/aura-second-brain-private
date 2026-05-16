# Voice-First Cinematic Pivot

Second Brain AI is now shaped as a voice-first ambient AI presence with unified memory.

## Product Model

- Home is an immersive AI voice presence, not a dashboard.
- Voice is primary. Text is a quiet fallback.
- Thoughts, notes, voice logs, goals, emotions, tasks, reminders, and recurring topics all enter one unified Memories system.
- Secondary utility lives behind the hamburger drawer.

## Navigation

- Home
- Memories
- Reminders
- Tasks
- Insights
- Search
- Settings
- Profile

## Rendering Strategy

The current build uses a lightweight mobile-safe rendering stack:

- procedural SVG star field
- animated intelligence orb
- state-based pulse/orbit motion
- no always-on microphone
- no heavy WebGL dependency yet

Quality strategy:

- Low: fewer stars, minimal background motion
- Balanced: default star field and orb motion
- Cinematic: richer visual layer planned for future shader/WebGL implementation

## Voice Strategy

- Expo AV records voice.
- Expo Speech provides native TTS fallback.
- Backend STT is wired through `/voice/transcribe`.
- Groq Whisper can be enabled by setting `GROQ_API_KEY` in `apps/api/.env`.
- Premium providers can later become subscription features.

## Secret Handling

Never hardcode provider keys in source or commit them to the app bundle.

Use `apps/api/.env`:

```bash
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=your_text_model
GROQ_API_KEY=your_groq_key
GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo
```

The iOS app should only know the backend URL through `apps/mobile/.env`:

```bash
EXPO_PUBLIC_API_URL=http://YOUR_MAC_OR_RAILWAY_URL:4000
```

## Performance Rules

- Keep particle counts capped.
- Avoid React state updates per animation frame.
- Pause/reduce rendering on non-home screens.
- Use balanced quality by default.
- Prefer emotional calm over technical spectacle.
