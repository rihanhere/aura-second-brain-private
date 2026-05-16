#!/usr/bin/env bash
set -euo pipefail

LANGUAGE="${1:-hi}"
SLOW="${GTTS_SLOW:-false}"
GTTS_TLD="${GTTS_TLD:-}"
TMP_DIR="${TMPDIR:-/tmp}/codex-gtts-voice"
TEXT_FILE="$TMP_DIR/input.txt"
OUTPUT_MP3="$TMP_DIR/codex-reply-${LANGUAGE}.mp3"

mkdir -p "$TMP_DIR"

if [ "$#" -gt 1 ]; then
  shift
  TEXT="$*"
else
  TEXT="$(pbpaste)"
fi

TEXT="$(printf "%s" "$TEXT" | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"

if [ -z "$TEXT" ]; then
  echo "Clipboard is empty. Copy a Codex reply first."
  exit 1
fi

printf "%s" "$TEXT" > "$TEXT_FILE"

if ! python3 - <<'PY' >/dev/null 2>&1
import gtts
PY
then
  echo "gTTS is not installed."
  echo "Run: python3 -m pip install --user gTTS"
  exit 2
fi

python3 - "$TEXT_FILE" "$OUTPUT_MP3" "$LANGUAGE" "$SLOW" "$GTTS_TLD" <<'PY'
import sys
from gtts import gTTS

input_path, output_path, language, slow, tld = sys.argv[1:6]
with open(input_path, "r", encoding="utf-8") as file:
    text = file.read().strip()

kwargs = {"text": text, "lang": language, "slow": slow.lower() == "true"}
if tld:
    kwargs["tld"] = tld
elif language == "hi":
    kwargs["tld"] = "co.in"

tts = gTTS(**kwargs)
tts.save(output_path)
PY

afplay "$OUTPUT_MP3"
