#!/bin/bash
export ANTHROPIC_API_KEY=$(cat ~/.claude/oauth-token.txt | python3 -c "import sys,json; print(json.load(sys.stdin)[\"claudeAiOauth\"][\"accessToken\"])")
exec claude -p --bare "$@"
