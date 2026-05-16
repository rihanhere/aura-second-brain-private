#!/usr/bin/env bash
set -euo pipefail

python3 -m pip install --user --upgrade gTTS

echo "gTTS installed."
echo "Test Hindi:"
echo 'echo "यह हिंदी voice test है।" | pbcopy && bash tools/codex-speak-gtts.sh hi'
echo "Test English:"
echo 'echo "This is an English voice test." | pbcopy && bash tools/codex-speak-gtts.sh en'
