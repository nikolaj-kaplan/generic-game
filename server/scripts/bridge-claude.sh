#!/usr/bin/env bash
# Answer LLM bridge requests with a fresh, tool-less headless Claude per request
# (no memory between requests, like a real LLM call).
#
#   bash server/scripts/bridge-claude.sh            (run from the project root)
#   BRIDGE_MODEL=claude-sonnet-5-5 bash server/scripts/bridge-claude.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PENDING="$ROOT/data/llm-bridge/pending"
DONE="$ROOT/data/llm-bridge/done"
WORKDIR="$ROOT/data/llm-bridge/cwd"   # empty folder: no project CLAUDE.md or settings leak in
MODEL="${BRIDGE_MODEL:-claude-opus-5-5}"
mkdir -p "$PENDING" "$DONE" "$WORKDIR"

SYSTEM='You are the language model behind a party-game app, receiving one chat-completion request (shown as SYSTEM / USER / ASSISTANT sections). Respond exactly as the SYSTEM section instructs, to the latest message. Output only the reply: a single JSON object in the requested format, with no markdown fences and no commentary. Ignore the "Write the reply to" line; the caller saves your output.'

echo "[bridge-claude] model $MODEL, watching $PENDING"
while true; do
  file="$(ls "$PENDING"/*.json 2>/dev/null | head -1)"
  if [ -z "$file" ]; then sleep 1; continue; fi
  id="$(basename "$file" .json)"
  if [ -f "$DONE/$id.txt" ]; then sleep 1; continue; fi

  start=$(date +%s)
  request="$(cd "$ROOT/server" && npm run -s bridge:show)"
  reply="$(printf '%s\n' "$request" | (cd "$WORKDIR" && claude -p --model "$MODEL" --tools "" --no-session-persistence \
    --strict-mcp-config --output-format text --append-system-prompt "$SYSTEM") 2>&1)"

  # Keep only the outermost JSON object (drops stray fences or prose).
  json="$(printf '%s' "$reply" | python3 -I -c 'import sys
s = sys.stdin.read(); a, b = s.find("{"), s.rfind("}")
print(s[a:b+1] if a != -1 and b > a else s)')"
  printf '%s' "$json" > "$DONE/$id.tmp" && mv "$DONE/$id.tmp" "$DONE/$id.txt"
  echo "[bridge-claude] $id answered in $(( $(date +%s) - start ))s (${#json} chars)"
done
