#!/bin/bash
# Sync laptop-only data sources to Mac Mini
# Run via cron on laptop: */30 * * * * ~/GitHub/prime/scripts/sync-laptop-sources.sh
#
# What this syncs:
# - Cowork sessions (Claude Desktop agent mode)
# - Claude Code sessions (CLI conversation JSONL + memory files)
#
# The Mac Mini connectors scan ~/laptop-sources/ in addition to local paths.

MAC_MINI="macmini"  # SSH alias — add to ~/.ssh/config if needed
REMOTE_BASE="laptop-sources"

# Cowork sessions
COWORK_SRC="$HOME/Library/Application Support/Claude/local-agent-mode-sessions/"
if [ -d "$COWORK_SRC" ]; then
  rsync -az --delete "$COWORK_SRC" "${MAC_MINI}:~/${REMOTE_BASE}/cowork/" 2>/dev/null
fi

# Claude Code sessions + memory files
CLAUDE_CODE_SRC="$HOME/.claude/projects/"
if [ -d "$CLAUDE_CODE_SRC" ]; then
  rsync -az --delete "$CLAUDE_CODE_SRC" "${MAC_MINI}:~/${REMOTE_BASE}/claude-code/" 2>/dev/null
fi

# Claude Code config sync (CLAUDE.md + settings.json → Mac Mini)
rsync -az "$HOME/.claude/CLAUDE.md" "${MAC_MINI}:~/.claude/CLAUDE.md" 2>/dev/null
rsync -az "$HOME/.claude/settings.json" "${MAC_MINI}:~/.claude/settings.json" 2>/dev/null
