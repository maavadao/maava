#!/usr/bin/env python3
"""Minimal forward-only migration runner.

Applies db/migrations/*.sql in filename order, each in its own transaction,
recording applied files in schema_migrations. Runs as the admin/owner role
(never app_api).

Usage: python db/migrate.py [--dsn postgresql://...]
Env:   ADMIN_DATABASE_URL (default: local docker-compose superuser DSN)
"""
import argparse
import os
import sys
from pathlib import Path

import psycopg

DEFAULT_DSN = "postgresql://postgres:postgres@localhost:5432/mawa_platform"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", default=os.environ.get("ADMIN_DATABASE_URL", DEFAULT_DSN))
    args = parser.parse_args()

    with psycopg.connect(args.dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS schema_migrations (
                     filename text PRIMARY KEY,
                     applied_at timestamptz NOT NULL DEFAULT now()
                   )"""
            )
            conn.commit()
            cur.execute("SELECT filename FROM schema_migrations")
            applied = {row[0] for row in cur.fetchall()}

        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in applied:
                continue
            print(f"applying {path.name} ...", flush=True)
            try:
                with conn.cursor() as cur:
                    cur.execute(path.read_text())
                    cur.execute(
                        "INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,)
                    )
                conn.commit()
            except Exception as exc:
                conn.rollback()
                print(f"FAILED {path.name}: {exc}", file=sys.stderr)
                return 1
        print("migrations up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
