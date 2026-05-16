#!/usr/bin/env bash
set -euo pipefail

TMP_DIR="${TMPDIR:-/tmp}/codex-gtts-voice"
TEXT_FILE="$TMP_DIR/mixed-input.txt"
OUT_DIR="$TMP_DIR/mixed"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.mp3

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

printf "%s" "$TEXT" > "$TEXT_FILE"

if ! python3 - <<'PY' >/dev/null 2>&1
import gtts
PY
then
  echo "gTTS is not installed."
  echo "Run: python3 -m pip install --user gTTS"
  exit 2
fi

python3 - "$TEXT_FILE" "$OUT_DIR" <<'PY'
import os
import re
import sys
from gtts import gTTS

input_path, out_dir = sys.argv[1:3]
with open(input_path, "r", encoding="utf-8") as file:
    text = file.read().strip()

parts = [part.strip() for part in re.split(r"(?<=[।.!?])\s+", text) if part.strip()]
if not parts:
    parts = [text]

for index, chunk in enumerate(parts):
    cleaned = re.sub(r"\s+", " ", chunk).strip()
    if not cleaned or not re.search(r"[\u0900-\u097FA-Za-z0-9]", cleaned):
        continue
    lang = "hi" if re.search(r"[\u0900-\u097F]", cleaned) else "en"
    path = os.path.join(out_dir, f"{index:03d}-{lang}.mp3")
    kwargs = {
        "text": cleaned,
        "lang": "hi" if lang == "hi" else "en",
        "slow": False,
    }
    if lang == "hi":
        kwargs["tld"] = "co.in"
    gTTS(**kwargs).save(path)
PY

shopt -s nullglob
FILES=("$OUT_DIR"/*.mp3)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No audio chunks generated."
  exit 1
fi

for file in "${FILES[@]}"; do
  afplay "$file"
done
