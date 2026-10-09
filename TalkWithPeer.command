#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Please install Node.js 22.13 or later."
  exit 1
fi
if [ ! -d node_modules ]; then npm install; fi
if [ ! -f dist/index.html ]; then npm run build; fi
exec node server/index.mjs
