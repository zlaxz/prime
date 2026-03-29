#!/bin/bash
# ============================================================
# Deploy Prime Recall to Mac Mini
# Run from laptop: bash scripts/deploy-mac-mini.sh
# ============================================================

set -e

REMOTE="zachstock@Zachs-Mac-mini.local"
REMOTE_REPO="~/GitHub/prime"
REMOTE_DB="~/.prime"
LOCAL_DB="$HOME/.prime/prime.db"
REPO_URL="git@github.com:zlaxz/prime-recall.git"

echo ""
echo "⚡ Deploying Prime Recall to Mac Mini"
echo "  Remote: $REMOTE"
echo ""

# ── Step 1: Clone or pull repo ──────────────────────────
echo "Step 1: Setting up repository..."
ssh "$REMOTE" bash -s <<'REPO_EOF'
  mkdir -p ~/GitHub
  if [ -d ~/GitHub/prime/.git ]; then
    cd ~/GitHub/prime && git pull origin main 2>/dev/null || echo "  Pull skipped (may need auth)"
  else
    cd ~/GitHub && git clone git@github.com:zlaxz/prime-recall.git prime 2>/dev/null || {
      echo "  SSH clone failed, trying HTTPS..."
      git clone https://github.com/zlaxz/prime-recall.git prime
    }
  fi
  echo "  ✓ Repo ready at ~/GitHub/prime"
REPO_EOF

# ── Step 2: Install dependencies ────────────────────────
echo "Step 2: Installing dependencies..."
ssh "$REMOTE" bash -s <<'DEPS_EOF'
  cd ~/GitHub/prime
  npm install --production=false 2>&1 | tail -3
  echo "  ✓ Dependencies installed"
DEPS_EOF

# ── Step 3: Copy database ───────────────────────────────
echo "Step 3: Copying database..."
ssh "$REMOTE" "mkdir -p ~/.prime/dream/results ~/.prime/logs/dream ~/.prime/briefings"

if [ -f "$LOCAL_DB" ]; then
  DB_SIZE=$(du -h "$LOCAL_DB" | cut -f1)
  echo "  Copying prime.db ($DB_SIZE)..."
  scp "$LOCAL_DB" "$REMOTE:~/.prime/prime.db"
  echo "  ✓ Database copied"
else
  echo "  ⚠ No local database found at $LOCAL_DB"
  echo "    Run 'recall init' on Mac Mini after deployment"
fi

# ── Step 4: Copy environment config ─────────────────────
echo "Step 4: Copying environment..."
if [ -f "$HOME/GitHub/prime/.env" ]; then
  scp "$HOME/GitHub/prime/.env" "$REMOTE:~/GitHub/prime/.env"
  echo "  ✓ .env copied"
fi

# ── Step 5: Install launchd daemons ─────────────────────
echo "Step 5: Installing launchd daemons..."
ssh "$REMOTE" bash -s <<'LAUNCHD_EOF'
  LAUNCH_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LAUNCH_DIR"
  TSX="$(which npx) tsx"
  PRIME_DIR="$HOME/GitHub/prime"
  LOG_DIR="$HOME/.prime/logs"
  mkdir -p "$LOG_DIR"

  # --- com.prime-recall.serve.plist (always running, HTTP + MCP) ---
  cat > "$LAUNCH_DIR/com.prime-recall.serve.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prime-recall.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which npx)</string>
    <string>tsx</string>
    <string>$PRIME_DIR/src/index.ts</string>
    <string>serve</string>
    <string>--port</string>
    <string>3210</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PRIME_DIR</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/serve.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/serve-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

  # --- com.prime-recall.sync.plist (every 15 minutes) ---
  cat > "$LAUNCH_DIR/com.prime-recall.sync.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prime-recall.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which npx)</string>
    <string>tsx</string>
    <string>$PRIME_DIR/src/index.ts</string>
    <string>sync</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PRIME_DIR</string>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/sync.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/sync-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

  # --- com.prime-recall.dream.plist (2 AM nightly) ---
  cat > "$LAUNCH_DIR/com.prime-recall.dream.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prime-recall.dream</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which npx)</string>
    <string>tsx</string>
    <string>$PRIME_DIR/src/index.ts</string>
    <string>dream</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PRIME_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/dream.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dream-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

  # --- com.prime-recall.briefing.plist (6:30 AM — open briefing) ---
  cat > "$LAUNCH_DIR/com.prime-recall.briefing.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.prime-recall.briefing</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which npx)</string>
    <string>tsx</string>
    <string>$PRIME_DIR/src/index.ts</string>
    <string>brief</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PRIME_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/briefing.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/briefing-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

  # Load all daemons
  for plist in serve sync dream briefing; do
    launchctl unload "$LAUNCH_DIR/com.prime-recall.$plist.plist" 2>/dev/null || true
    launchctl load "$LAUNCH_DIR/com.prime-recall.$plist.plist"
    echo "  ✓ Loaded com.prime-recall.$plist"
  done
LAUNCHD_EOF

# ── Step 6: Verify ──────────────────────────────────────
echo ""
echo "Step 6: Verifying deployment..."
ssh "$REMOTE" bash -s <<'VERIFY_EOF'
  echo "  Daemons:"
  launchctl list | grep prime-recall | while read pid status label; do
    echo "    $label (pid: $pid, status: $status)"
  done

  # Wait for server to start
  sleep 3
  echo ""
  echo "  Server health:"
  curl -s http://localhost:3210/api/health 2>/dev/null || echo "    ⚠ Server not responding yet (may still be starting)"
  echo ""

  echo "  Database:"
  if [ -f ~/.prime/prime.db ]; then
    SIZE=$(du -h ~/.prime/prime.db | cut -f1)
    echo "    ✓ prime.db exists ($SIZE)"
  else
    echo "    ⚠ No database — run 'recall init' on Mac Mini"
  fi
VERIFY_EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Deployment complete!"
echo ""
echo "  Server:   http://Zachs-Mac-mini.local:3210"
echo "  MCP:      http://Zachs-Mac-mini.local:3210/mcp"
echo "  API:      http://Zachs-Mac-mini.local:3210/api/status"
echo "  Dashboard: http://Zachs-Mac-mini.local:3210/dashboard"
echo ""
echo "  Next: Configure Claude Desktop on laptop to use remote MCP"
echo "  Edit ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "  Add: \"prime-recall-remote\": { \"url\": \"http://Zachs-Mac-mini.local:3210/mcp\" }"
echo ""
