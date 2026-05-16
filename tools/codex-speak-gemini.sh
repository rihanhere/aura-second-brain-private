#!/usr/bin/env bash
set -euo pipefail

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

CONFIG_HOME="${HOME}/.codex-gemini-voice.env"
CONFIG_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.gemini.local.env"

if [ -f "$CONFIG_HOME" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_HOME"
elif [ -f "$CONFIG_LOCAL" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_LOCAL"
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Missing GEMINI_API_KEY."
  echo "Create ~/.codex-gemini-voice.env or .gemini.local.env."
  exit 1
fi

MODEL_ID="${GEMINI_TTS_MODEL:-gemini-2.5-flash-preview-tts}"
VOICE_NAME="${GEMINI_TTS_VOICE:-Sulafat}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
FFMPEG_BIN="${FFMPEG_BIN:-/opt/homebrew/bin/ffmpeg}"

if [ "$#" -gt 0 ]; then
  TEXT="$*"
else
  TEXT="$(pbpaste)"
fi

TEXT="$(printf "%s" "$TEXT" | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"

if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  TEXT="$(cat | sed 's/[[:space:]]\{1,\}/ /g' | sed 's/^ *//;s/ *$//')"
fi

if [ -z "$TEXT" ]; then
  echo "Clipboard is empty. Copy a Codex reply first."
  exit 1
fi

TMP_DIR="/tmp/codex-gemini-voice"
mkdir -p "$TMP_DIR"
REQUEST_JSON="$TMP_DIR/request.json"
RESPONSE_JSON="$TMP_DIR/response.json"
OUTPUT_PCM="$TMP_DIR/codex-reply.pcm"
OUTPUT_WAV="$TMP_DIR/codex-reply.wav"
LOG_FILE="/tmp/codex-gemini-last.log"

{
  date
  printf "MODEL_ID: %s\n" "$MODEL_ID"
  printf "VOICE_NAME: %s\n" "$VOICE_NAME"
  printf "TEXT: %s\n" "$TEXT"
} > "$LOG_FILE"

"$NODE_BIN" - "$TEXT" "$MODEL_ID" "$VOICE_NAME" "$REQUEST_JSON" <<'NODE'
const fs = require("fs");
const [text, modelId, voiceName, requestPath] = process.argv.slice(2);

const prompt = `Read this clearly in natural Hindi / Hinglish, calm and warm, slightly faster than normal, with good pronunciation. Read the exact text, do not add anything:\n\n${text}`;

fs.writeFileSync(requestPath, JSON.stringify({
  contents: [{
    parts: [{ text: prompt }]
  }],
  generationConfig: {
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName
        }
      }
    }
  },
  model: modelId
}));
NODE

curl --fail --silent --show-error \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent" \
  -H "x-goog-api-key: ${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -X POST \
  --data-binary "@${REQUEST_JSON}" \
  --output "$RESPONSE_JSON"

"$NODE_BIN" - "$RESPONSE_JSON" "$OUTPUT_PCM" <<'NODE'
const fs = require("fs");
const [responsePath, pcmPath] = process.argv.slice(2);
const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
const data =
  response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ||
  response?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;

if (!data) {
  console.error(JSON.stringify(response, null, 2));
  process.exit(1);
}

fs.writeFileSync(pcmPath, Buffer.from(data, "base64"));
NODE

"$FFMPEG_BIN" -y -loglevel error -f s16le -ar 24000 -ac 1 -i "$OUTPUT_PCM" "$OUTPUT_WAV"
afplay "$OUTPUT_WAV"
