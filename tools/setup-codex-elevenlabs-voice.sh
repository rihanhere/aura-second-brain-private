#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${HOME}/.codex-elevenlabs-voice.env"

read -r -s -p "ElevenLabs API key: " API_KEY
printf "\n"
read -r -p "Voice ID [JBFqnCBsd6RMkjVDRZzb]: " VOICE_ID
VOICE_ID="${VOICE_ID:-JBFqnCBsd6RMkjVDRZzb}"
read -r -p "Language code [hi]: " LANGUAGE_CODE
LANGUAGE_CODE="${LANGUAGE_CODE:-hi}"

cat > "$CONFIG_FILE" <<EOF
ELEVENLABS_API_KEY="$API_KEY"
ELEVENLABS_VOICE_ID="$VOICE_ID"
ELEVENLABS_MODEL_ID="eleven_multilingual_v2"
ELEVENLABS_LANGUAGE_CODE="$LANGUAGE_CODE"
ELEVENLABS_OUTPUT_FORMAT="mp3_44100_128"
EOF

chmod 600 "$CONFIG_FILE"
echo "Saved ElevenLabs voice config to $CONFIG_FILE"
