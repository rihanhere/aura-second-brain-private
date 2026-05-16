#!/usr/bin/env bash
set -euo pipefail

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

TMP_DIR="/tmp/codex-gtts-voice"
TEXT_FILE="$TMP_DIR/hindi-input.txt"
OUTPUT_MP3="$TMP_DIR/codex-reply-hindi.mp3"
FAST_MP3="$TMP_DIR/codex-reply-hindi-fast.mp3"
LOG_FILE="/tmp/codex-gtts-last.log"
SPEECH_SPEED="${CODEX_TTS_SPEED:-1.22}"

mkdir -p "$TMP_DIR"

SOURCE="arguments"
if [ "$#" -gt 0 ]; then
  TEXT="$*"
else
  SOURCE="clipboard-after-autocopy"
  osascript -e 'tell application "System Events" to keystroke "c" using command down' >/dev/null 2>&1 || true
  sleep 0.2
  TEXT="$(pbpaste)"
fi

TEXT="$(printf "%s" "$TEXT" | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"

# The Shortcut is meant to run after Command-C. Prefer clipboard because
# macOS Quick Action stdin can be incomplete in some apps.
if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  SOURCE="stdin"
  TEXT="$(cat | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"
fi

if [ -z "$TEXT" ]; then
  echo "Clipboard is empty. Copy a Codex reply first."
  exit 1
fi

printf "%s" "$TEXT" > "$TEXT_FILE"
{
  date
  printf "SOURCE: %s\n" "$SOURCE"
  printf "SPEED: %s\n" "$SPEECH_SPEED"
  printf "TEXT: %s\n" "$TEXT"
} > "$LOG_FILE"

if ! python3 - <<'PY' >/dev/null 2>&1
import gtts
PY
then
  echo "gTTS is not installed."
  echo "Run: python3 -m pip install --user gTTS"
  exit 2
fi

python3 - "$TEXT_FILE" "$OUTPUT_MP3" <<'PY'
import sys
from gtts import gTTS

input_path, output_path = sys.argv[1:3]
with open(input_path, "r", encoding="utf-8") as file:
    text = file.read().strip()

tts = gTTS(text=text, lang="hi", tld="co.in", slow=False)
tts.save(output_path)
PY

if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -loglevel error -i "$OUTPUT_MP3" -filter:a "atempo=$SPEECH_SPEED" "$FAST_MP3"
  afplay "$FAST_MP3"
else
  afplay "$OUTPUT_MP3"
fi
