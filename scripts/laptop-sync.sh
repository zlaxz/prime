#!/bin/bash
# Sync laptop-only sources (Cowork + Claude Code) to Mac Mini
# Runs on laptop, writes to Mac Mini DB via recall commands

cd /Users/zstoc/GitHub/prime

echo "[$(date)] Laptop sync starting..."

# Sync Claude Code sessions (laptop → Mac Mini DB)
echo "  Syncing Claude Code..."
npx tsx src/index.ts connect claude-code 2>&1 | tail -3

# Sync Cowork sessions (laptop → Mac Mini DB)  
echo "  Syncing Cowork..."
npx tsx src/index.ts sync 2>&1 | grep -E "cowork|claude-code|Claude Code|Cowork" | tail -5

echo "[$(date)] Laptop sync complete"
