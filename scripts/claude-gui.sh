#!/bin/bash
# Run claude -p in GUI Terminal context (Keychain accessible)
# Works from SSH, cron, launchd — anywhere.
# Uses osascript to open a Terminal tab in the GUI session.
#
# Usage: echo "prompt" | ~/GitHub/prime/scripts/claude-gui.sh [--resume UUID]

OUTFILE="/tmp/claude-gui-$$.txt"
PROMPT=$(cat)
ARGS="$@"

echo "$PROMPT" > "/tmp/claude-gui-prompt-$$.txt"

# Always load Prime MCP tools (permissions in ~/.claude/settings.json handle auto-approve)
MCP_CONFIG="$HOME/.claude/.mcp.json"
MCP_FLAG=""
if [ -f "$MCP_CONFIG" ]; then
  MCP_FLAG="--mcp-config $MCP_CONFIG"
fi

osascript -e "tell application \"Terminal\" to do script \"cat /tmp/claude-gui-prompt-$$.txt | claude -p $MCP_FLAG $ARGS > $OUTFILE 2>&1; echo __DONE__ >> $OUTFILE; exit\"" > /dev/null 2>&1

# Wait for completion — 60 minutes max for deep sessions
for i in $(seq 1 720); do
  if [ -f "$OUTFILE" ] && grep -q "__DONE__" "$OUTFILE" 2>/dev/null; then
    sed '/__DONE__/d' "$OUTFILE"
    rm -f "$OUTFILE" "/tmp/claude-gui-prompt-$$.txt"
    exit 0
  fi
  sleep 5
done

echo "TIMEOUT: claude -p did not complete in 60 minutes" >&2
cat "$OUTFILE" 2>/dev/null
rm -f "$OUTFILE" "/tmp/claude-gui-prompt-$$.txt"
exit 1
