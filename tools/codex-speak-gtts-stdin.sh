#!/usr/bin/env bash
set -euo pipefail

LANGUAGE="${1:-hi}"
TMP_DIR="${TMPDIR:-/tmp}/codex-gtts-voice"
INPUT_FILE="$TMP_DIR/service-input.txt"

mkdir -p "$TMP_DIR"

cat > "$INPUT_FILE"

if [ ! -s "$INPUT_FILE" ]; then
  echo "No selected text received."
  exit 1
fi

TEXT="$(cat "$INPUT_FILE")"

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-speak-gtts.sh" "$LANGUAGE" "$TEXT"
