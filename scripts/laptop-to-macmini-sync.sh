#!/bin/bash
# ============================================================
# Laptop → Mac Mini sync for local-only sources
#
# Runs on the laptop. Scans Cowork + Claude Code locally,
# then copies the updated DB to Mac Mini.
#
# Schedule: every 30 min via launchd
# ============================================================

set -e
cd /Users/zstoc/GitHub/prime
LOG="$HOME/.prime/logs/laptop-sync.log"

echo "[$(date)] Laptop sync starting..." >> "$LOG"

# Step 1: Pause the Mac Mini → laptop rsync (to avoid conflicts)
# (The 2-min rsync will resume automatically)

# Step 2: Copy Mac Mini's DB to laptop (get latest)
rsync -az zachstock@Zachs-Mac-mini.local:~/.prime/prime.db ~/.prime/prime.db.tmp 2>/dev/null
mv ~/.prime/prime.db.tmp ~/.prime/prime.db

# Step 3: Run connectors that scan LOCAL paths (writes to local DB)
npx tsx src/index.ts connect claude-code 2>&1 | tail -3 >> "$LOG"

# Step 4: Copy updated DB BACK to Mac Mini (laptop additions included)
scp ~/.prime/prime.db zachstock@Zachs-Mac-mini.local:~/.prime/prime.db 2>/dev/null

echo "[$(date)] Laptop sync complete" >> "$LOG"
