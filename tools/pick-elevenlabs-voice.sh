#!/usr/bin/env bash
set -euo pipefail

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
  echo "Missing ELEVENLABS_API_KEY. Run tools/setup-codex-elevenlabs-voice.sh first."
  exit 1
fi

MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_flash_v2_5}"
LANGUAGE_CODE="${ELEVENLABS_LANGUAGE_CODE:-hi}"
OUTPUT_FORMAT="${ELEVENLABS_OUTPUT_FORMAT:-mp3_44100_128}"
TMP_DIR="${TMPDIR:-/tmp}/codex-elevenlabs-voice"
mkdir -p "$TMP_DIR"
VOICES_JSON="$TMP_DIR/voices.json"
REQUEST_JSON="$TMP_DIR/test-request.json"
OUTPUT_MP3="$TMP_DIR/test-voice.mp3"

echo "Fetching ElevenLabs voices..."
curl --fail --silent --show-error \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  "https://api.elevenlabs.io/v1/voices" \
  --output "$VOICES_JSON"

node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const voices = data.voices || [];
if (!voices.length) {
  console.error("No voices found on this ElevenLabs account.");
  process.exit(1);
}
for (const voice of voices.slice(0, 30)) {
  const labels = voice.labels ? Object.entries(voice.labels).map(([k, v]) => `${k}:${v}`).join(", ") : "";
  console.log(`${voice.voice_id}\t${voice.name}\t${voice.category || ""}\t${labels}`);
}
' "$VOICES_JSON"

VOICE_ID="$(node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const voices = data.voices || [];
const preferred = voices.find(v => /hindi|india|indian/i.test(`${v.name} ${JSON.stringify(v.labels || {})}`));
const fallback = preferred || voices.find(v => v.category !== "generated") || voices[0];
if (!fallback) process.exit(1);
console.log(fallback.voice_id);
' "$VOICES_JSON")"

VOICE_NAME="$(node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const id = process.argv[2];
const voice = (data.voices || []).find(v => v.voice_id === id);
console.log(voice ? voice.name : id);
' "$VOICES_JSON" "$VOICE_ID")"

echo "Testing voice: $VOICE_NAME ($VOICE_ID)"

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  text: "नमस्ते। यह Codex voice test है। अगर यह आवाज़ साफ़ है, तो हम इसी voice को use करेंगे।",
  model_id: process.argv[2],
  language_code: process.argv[3],
  voice_settings: {
    stability: 0.52,
    similarity_boost: 0.82,
    style: 0.18,
    use_speaker_boost: true
  }
}));
' "$REQUEST_JSON" "$MODEL_ID" "$LANGUAGE_CODE"

if ! curl --fail --silent --show-error \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary "@${REQUEST_JSON}" \
  --output "$OUTPUT_MP3"; then
  echo ""
  echo "ElevenLabs test generation failed."
  echo "If the error is 402, this account/key has no usable quota or billing for TTS right now."
  exit 1
fi

afplay "$OUTPUT_MP3"

cat > "$CONFIG_HOME" <<EOF
ELEVENLABS_API_KEY="$ELEVENLABS_API_KEY"
ELEVENLABS_VOICE_ID="$VOICE_ID"
ELEVENLABS_MODEL_ID="$MODEL_ID"
ELEVENLABS_LANGUAGE_CODE="$LANGUAGE_CODE"
ELEVENLABS_OUTPUT_FORMAT="$OUTPUT_FORMAT"
EOF

chmod 600 "$CONFIG_HOME"
echo "Saved working voice to $CONFIG_HOME"
