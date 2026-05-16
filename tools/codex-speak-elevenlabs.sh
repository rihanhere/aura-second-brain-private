#!/usr/bin/env bash
set -euo pipefail

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

CONFIG_HOME="${HOME}/.codex-elevenlabs-voice.env"
CONFIG_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.elevenlabs.local.env"

if [ -f "$CONFIG_HOME" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_HOME"
elif [ -f "$CONFIG_LOCAL" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_LOCAL"
fi

if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  echo "Missing ELEVENLABS_API_KEY."
  echo "Create ~/.codex-elevenlabs-voice.env or .elevenlabs.local.env."
  exit 1
fi

VOICE_ID="${ELEVENLABS_VOICE_ID:-SAz9YHcvj6GT2YYXdXww}"
MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_flash_v2_5}"
LANGUAGE_CODE="${ELEVENLABS_LANGUAGE_CODE:-hi}"
OUTPUT_FORMAT="${ELEVENLABS_OUTPUT_FORMAT:-mp3_44100_128}"
SPEECH_SPEED="${ELEVENLABS_SPEED:-1.08}"

if [ "$#" -gt 0 ]; then
  TEXT="$*"
else
  TEXT="$(pbpaste)"
fi

TEXT="$(printf "%s" "$TEXT" | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"

if [ -z "$TEXT" ]; then
  echo "Clipboard is empty. Copy a Codex reply first."
  exit 1
fi

TMP_DIR="/tmp/codex-elevenlabs-voice"
mkdir -p "$TMP_DIR"
REQUEST_JSON="$TMP_DIR/request.json"
OUTPUT_MP3="$TMP_DIR/codex-reply.mp3"
FAST_MP3="$TMP_DIR/codex-reply-fast.mp3"
LOG_FILE="/tmp/codex-elevenlabs-last.log"

{
  date
  printf "VOICE_ID: %s\n" "$VOICE_ID"
  printf "MODEL_ID: %s\n" "$MODEL_ID"
  printf "LANGUAGE_CODE: %s\n" "$LANGUAGE_CODE"
  printf "SPEED: %s\n" "$SPEECH_SPEED"
  printf "TEXT: %s\n" "$TEXT"
} > "$LOG_FILE"

node -e '
const fs = require("fs");
const text = process.argv[1];
const model_id = process.argv[2];
const language_code = process.argv[3];
fs.writeFileSync(process.argv[4], JSON.stringify({
  text,
  model_id,
  language_code,
  voice_settings: {
    stability: 0.52,
    similarity_boost: 0.82,
    style: 0.18,
    use_speaker_boost: true
  }
}));
' "$TEXT" "$MODEL_ID" "$LANGUAGE_CODE" "$REQUEST_JSON"

curl --fail --silent --show-error \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary "@${REQUEST_JSON}" \
  --output "$OUTPUT_MP3"

if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -loglevel error -i "$OUTPUT_MP3" -filter:a "atempo=$SPEECH_SPEED" "$FAST_MP3"
  afplay "$FAST_MP3"
else
  afplay "$OUTPUT_MP3"
fi
