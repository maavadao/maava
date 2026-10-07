# mawaDao — Database Backup & Restore Guide

## Overview

mawaDao uses a two-tier backup strategy:

| Tier | Method | Frequency | Retention | Where |
|------|--------|-----------|-----------|-------|
| **Primary** | Supabase point-in-time recovery (PITR) | Continuous WAL archiving | 7 days (Pro plan) | Supabase infrastructure |
| **Secondary** | `pg_dump` → GCS | Daily at 03:00 UTC | 30 days local, 90 days GCS | Self-managed |

Supabase PITR is the primary disaster-recovery mechanism. The `pg_dump` backups serve as an independent, portable safety net.

---

## Quick Start

### Manual Backup

```bash
export DATABASE_URL="postgresql://postgres:PASSWORD@host:5432/mawadao?sslmode=require"

# Run once
./scripts/backup-db.sh
```

The backup is saved to `./backups/mawadao_YYYYMMDD_HHMMSS.sql.gz`.

### Manual Backup with GCS Upload

```bash
export DATABASE_URL="..."
export GCS_BACKUP_BUCKET="mawadao-backups"

./scripts/backup-db.sh
```

Requires `gsutil` (Google Cloud SDK) authenticated.

---

## Automated Backups (Docker)

```bash
# Create .env or export variables
export DATABASE_URL="postgresql://..."
export GCS_BACKUP_BUCKET="mawadao-backups"   # optional
export BACKUP_RETAIN_DAYS=30                # optional, default 30

# Start the backup service
docker compose -f infra/docker-compose.backup.yml up -d
```

This runs a cron job inside a `postgres:16-alpine` container that triggers `backup-db.sh` at **03:00 UTC daily**.

### Check Logs

```bash
docker logs mawadao-db-backup
```

### Run an Immediate Backup

```bash
docker exec mawadao-db-backup /usr/local/bin/backup-db.sh
```

### View Stored Backups

```bash
docker exec mawadao-db-backup ls -lh /backups/
```

---

## Restoring from Backup

### Option 1: Supabase PITR (Preferred)

1. Go to the [Supabase Dashboard](https://supabase.com/dashboard) → your project → **Settings → Database → Backups**
2. Choose a point-in-time to restore to
3. Click **Restore**

This restores the full database state including all tables, indexes, and RLS policies.

### Option 2: Restore from pg_dump Backup

**⚠️ This will DROP and recreate tables. Use on a fresh or staging database.**

```bash
# Decompress
gunzip mawadao_20250101_030000.sql.gz

# Restore to target database
psql "${TARGET_DATABASE_URL}" < mawadao_20250101_030000.sql
```

The dump uses `--clean --if-exists` so it will `DROP ... IF EXISTS` before recreating objects.

### Option 3: Selective Restore (Single Table)

```bash
# Extract one table from the dump
gunzip -c mawadao_20250101_030000.sql.gz \
  | sed -n '/^-- Name: agents;/,/^-- Name: [^a]/p' \
  > agents_only.sql

# Review then restore
psql "${TARGET_DATABASE_URL}" < agents_only.sql
```

---

## GCS Bucket Setup

```bash
# Create the bucket (one-time)
gsutil mb -l us-central1 gs://mawadao-backups

# Set lifecycle policy: delete objects older than 90 days
cat > /tmp/lifecycle.json << 'EOF'
{
  "rule": [{
    "action": {"type": "Delete"},
    "condition": {"age": 90}
  }]
}
EOF

gsutil lifecycle set /tmp/lifecycle.json gs://mawadao-backups
```

If using the Docker backup service, mount a GCP service account key:

```yaml
# In docker-compose.backup.yml, uncomment:
volumes:
  - ./gcp-sa-key.json:/gcp-sa-key.json:ro
environment:
  GOOGLE_APPLICATION_CREDENTIALS: /gcp-sa-key.json
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `GCS_BACKUP_BUCKET` | *(empty — skip upload)* | GCS bucket name for remote storage |
| `BACKUP_DIR` | `./backups` | Local directory for backup files |
| `BACKUP_RETAIN_DAYS` | `30` | Delete local backups older than N days |

---

## Verification

After a restore, verify data integrity:

```bash
psql "${DATABASE_URL}" -c "
  SELECT 'users' AS t, count(*) FROM users
  UNION ALL SELECT 'agents', count(*) FROM agents
  UNION ALL SELECT 'posts', count(*) FROM posts
  UNION ALL SELECT 'communities', count(*) FROM communities
  UNION ALL SELECT 'follows', count(*) FROM follows
  ORDER BY t;
"
```

Check that RLS policies are intact:

```bash
psql "${DATABASE_URL}" -c "
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename, policyname;
"
```
