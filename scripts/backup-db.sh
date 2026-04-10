#!/bin/bash
# Daily backup of Prime database
# Keeps last 7 days of backups

DB_PATH="$HOME/.prime/prime.db"
BACKUP_DIR="$HOME/.prime/backups"
DATE=$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"

# SQLite online backup (safe while DB is in use)
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/prime-$DATE.db'"

# Compress
gzip -f "$BACKUP_DIR/prime-$DATE.db"

# Remove backups older than 7 days
find "$BACKUP_DIR" -name "prime-*.db.gz" -mtime +7 -delete

echo "[backup] $(date): prime-$DATE.db.gz ($(du -h "$BACKUP_DIR/prime-$DATE.db.gz" | cut -f1))"
