# Codex Reply Voice With gTTS

This lets you copy a Codex reply, press a shortcut, and hear it using Google Text-to-Speech.

## Install

From this project folder:

```bash
bash tools/install-gtts-voice.sh
```

## Test Hindi

```bash
echo "यह हिंदी voice test है।" | pbcopy
bash tools/codex-speak-gtts.sh hi
```

## Test English

```bash
echo "This is an English voice test." | pbcopy
bash tools/codex-speak-gtts.sh en
```

## macOS Shortcut For Hindi

1. Open Shortcuts app.
2. Create a new shortcut.
3. Add action: `Run Shell Script`.
4. Put this:

```bash
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
bash tools/codex-speak-gtts-hindi.sh
```

5. Assign a keyboard shortcut.

Daily use:

```text
Select Codex reply.
Command C.
Press shortcut.
Hindi voice plays.
```

This is the most reliable flow. macOS selected-text Services can be inconsistent, so this setup intentionally uses the clipboard.

## macOS Shortcut For English

Create another shortcut with:

```bash
cd /Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
bash tools/codex-speak-gtts.sh en
```

## Notes

- `hi` means Hindi.
- `en` means English.
- This needs internet because gTTS uses Google Text-to-Speech.
- No API key is required.
