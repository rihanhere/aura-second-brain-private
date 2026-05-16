# Codex Reply Voice With ElevenLabs

This lets you copy a Codex reply, press a shortcut, and hear it through ElevenLabs.

## One-Time Setup

Run:

```bash
bash tools/setup-codex-elevenlabs-voice.sh
```

Paste your ElevenLabs API key when asked.

## Test

Copy Hindi text, then run:

```bash
bash tools/codex-speak-elevenlabs.sh
```

The script reads your clipboard, sends it to ElevenLabs, saves an MP3 in `/tmp`, and plays it with `afplay`.

## Pick And Test A Voice Automatically

Run:

```bash
bash tools/pick-elevenlabs-voice.sh
```

It fetches voices from your ElevenLabs account, picks a likely usable voice, generates a Hindi test line, plays it, and saves the selected voice ID.

If it returns `402`, the API key/account currently has no usable TTS quota or billing.

## macOS Shortcut

1. Open Shortcuts app.
2. Create a new shortcut.
3. Add action: `Run Shell Script`.
4. Use:

```bash
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
bash tools/codex-speak-elevenlabs.sh
```

5. Assign a keyboard shortcut.

Daily use:

```text
Select Codex reply
Command C
Press your shortcut
```

## Changing Voice

Edit:

```bash
~/.codex-elevenlabs-voice.env
```

Change:

```bash
ELEVENLABS_VOICE_ID="your_voice_id"
```

For Hindi, keep:

```bash
ELEVENLABS_MODEL_ID="eleven_multilingual_v2"
ELEVENLABS_LANGUAGE_CODE="hi"
```
