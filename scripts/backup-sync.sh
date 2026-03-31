#!/bin/bash
# Oraculo backup sync — runs on CT 300 via cron
# Syncs El Pesos DB backup from CT 100 to /shared/backups/crypto/

BACKUP_DIR="/shared/backups/crypto"
ORACULO_BACKUP_DIR="/shared/backups/oraculo"

mkdir -p "$BACKUP_DIR" "$ORACULO_BACKUP_DIR"

# Sync trading DB from CT 100
rsync -az --timeout=30 root@${BACKUP_HOST:-localhost}:/opt/backups/ "$BACKUP_DIR/" 2>/dev/null

# Backup Oraculo state files
cp -f /shared/oraculo/confidence-state.json "$ORACULO_BACKUP_DIR/" 2>/dev/null
cp -f /shared/oraculo/goals-state.json "$ORACULO_BACKUP_DIR/" 2>/dev/null

# Backup signal history (last 7 days)
find /shared/oraculo/signals/ -name "*.json" -mtime -7 -exec cp {} "$ORACULO_BACKUP_DIR/signals/" \; 2>/dev/null

# pgvector dump (daily)
HOUR=$(date +%H)
if [ "$HOUR" = "03" ]; then
  pg_dump -h localhost -U ${PGUSER:-postgres} ${PGDATABASE:-knowledge} > "$ORACULO_BACKUP_DIR/knowledge-$(date +%Y%m%d).sql" 2>/dev/null
  # Keep 14 days
  find "$ORACULO_BACKUP_DIR" -name "knowledge-*.sql" -mtime +14 -delete 2>/dev/null
fi

echo "$(date): Backup sync complete" >> /shared/oraculo/logs/backup.log
