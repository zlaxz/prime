#!/bin/bash
# Rotate Prime logs — keeps last 5 rotations, max 1MB per file
LOG_DIR="$HOME/.prime/logs"
MAX_SIZE=1048576  # 1MB

for logfile in "$LOG_DIR"/*.log; do
    [ -f "$logfile" ] || continue
    size=$(stat -f%z "$logfile" 2>/dev/null || stat -c%s "$logfile" 2>/dev/null)
    if [ "$size" -gt "$MAX_SIZE" ]; then
        # Rotate: .log.4 → .log.5, .log.3 → .log.4, etc.
        for i in 4 3 2 1; do
            [ -f "${logfile}.$i" ] && mv "${logfile}.$i" "${logfile}.$((i+1))"
        done
        mv "$logfile" "${logfile}.1"
        > "$logfile"  # Create fresh empty log
        echo "[rotate] $(date): Rotated $(basename $logfile) ($size bytes)"
    fi
done
