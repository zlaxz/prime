#!/bin/bash
# Kill any existing shift processes before starting new one
# Prevents zombie process accumulation when launchd restarts
pkill -f "index.ts shift" 2>/dev/null
sleep 1
pkill -9 -f "index.ts shift" 2>/dev/null
cd /Users/zachstock/GitHub/prime
exec npx tsx src/index.ts shift
