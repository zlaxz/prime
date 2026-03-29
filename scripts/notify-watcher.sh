#!/bin/bash
# ============================================================
# Notify Watcher — runs on Mac Mini in screen session (GUI context)
# Monitors for new dream pipeline results and sends iMessage
# ============================================================

PRIME_DIR="$HOME/GitHub/prime"
DB="$HOME/.prime/prime.db"
STATE_FILE="$HOME/.prime/last-notified-dream"

echo "[notify-watcher] Started. Monitoring for dream pipeline completions..."

while true; do
  # Check last dream run
  LAST_DREAM=$(sqlite3 "$DB" "SELECT value FROM graph_state WHERE key='last_dream_run'" 2>/dev/null)
  LAST_NOTIFIED=$(cat "$STATE_FILE" 2>/dev/null || echo "")

  if [ -n "$LAST_DREAM" ] && [ "$LAST_DREAM" != "$LAST_NOTIFIED" ]; then
    echo "[notify-watcher] New dream run detected: $LAST_DREAM"

    # Get pending actions
    PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM staged_actions WHERE status='pending' AND (expires_at IS NULL OR expires_at > datetime('now'))" 2>/dev/null)

    if [ "$PENDING" -gt 0 ]; then
      # Build action list
      ACTIONS=$(sqlite3 "$DB" "SELECT id, type, summary FROM staged_actions WHERE status='pending' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY id" 2>/dev/null)

      MSG="Prime Dream Complete: $PENDING actions ready.\n\n"
      I=1
      while IFS='|' read -r ID TYPE SUMMARY; do
        MSG="${MSG}${I}. [${TYPE}] ${SUMMARY}\n"
        I=$((I + 1))
      done <<< "$ACTIONS"
      MSG="${MSG}\nReply YES to approve all, or # for specific."

      # Send via osascript (works in GUI screen session)
      PHONE=$(sqlite3 "$DB" "SELECT value FROM config WHERE key='notify_phone_number'" 2>/dev/null | tr -d '"')
      if [ -n "$PHONE" ]; then
        ESCAPED=$(echo -e "$MSG" | sed 's/"/\\"/g' | tr '\n' ' ')
        osascript -e "tell application \"Messages\" to send \"$ESCAPED\" to buddy \"$PHONE\"" 2>/dev/null
        if [ $? -eq 0 ]; then
          echo "[notify-watcher] iMessage sent to $PHONE ($PENDING actions)"
        else
          echo "[notify-watcher] iMessage send failed"
        fi
      fi
    else
      echo "[notify-watcher] No pending actions to notify about"
    fi

    # Mark as notified
    echo "$LAST_DREAM" > "$STATE_FILE"
  fi

  sleep 60  # Check every minute
done
