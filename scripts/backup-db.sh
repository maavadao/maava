#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# maavaDao DB Backup Script
#
# Takes a pg_dump of the Supabase PostgreSQL database,
# compresses it with gzip, and optionally uploads to GCS.
#
# Environment variables:
#   DATABASE_URL    (required) — Full PostgreSQL connection string
#   GCS_BACKUP_BUCKET          — GCS bucket for remote backups (optional)
#   BACKUP_DIR                 — Local backup directory (default: ./backups)
#   BACKUP_RETAIN_DAYS         — Days to keep local backups (default: 30)
#
# Usage:
#   ./scripts/backup-db.sh                  # manual run
#   0 3 * * * /path/to/backup-db.sh         # cron (3 AM daily)
# ─────────────────────────────────────────────────────────
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/maavadao_${TIMESTAMP}.sql.gz"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Validate DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

echo "[$(date -Iseconds)] Starting backup → ${BACKUP_FILE}"

# pg_dump with custom format would be ideal, but plain SQL + gzip is most portable.
# --no-owner --no-privileges so restores work on any target.
pg_dump "${DATABASE_URL}" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --format=plain \
  | gzip > "${BACKUP_FILE}"

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "[$(date -Iseconds)] Backup complete: ${FILE_SIZE}"

# Upload to GCS if bucket is configured
if [ -n "${GCS_BACKUP_BUCKET:-}" ]; then
  GCS_PATH="gs://${GCS_BACKUP_BUCKET}/db-backups/maavadao_${TIMESTAMP}.sql.gz"
  echo "[$(date -Iseconds)] Uploading to ${GCS_PATH}"
  gsutil cp "${BACKUP_FILE}" "${GCS_PATH}"
  echo "[$(date -Iseconds)] Upload complete"
fi

# Prune old local backups
PRUNED=$(find "${BACKUP_DIR}" -name "maavadao_*.sql.gz" -mtime +"${BACKUP_RETAIN_DAYS}" -print -delete | wc -l)
if [ "${PRUNED}" -gt 0 ]; then
  echo "[$(date -Iseconds)] Pruned ${PRUNED} backup(s) older than ${BACKUP_RETAIN_DAYS} days"
fi

echo "[$(date -Iseconds)] Done"
