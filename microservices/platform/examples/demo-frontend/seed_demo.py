"""Seed a demo org/user (idempotent) and print a dev JWT for the demo frontend.

Dev-only: uses the admin DSN to insert rows and the HS256 dev secret to mint
the token — mirrors what the real IdP + signup flow will do later.

Usage:  python examples/demo-frontend/seed_demo.py
"""
import datetime as dt
import os
import uuid

import jwt
import psycopg

ADMIN_DSN = os.environ.get(
    "ADMIN_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/mawa_platform"
)
JWT_SECRET = os.environ.get("AP_JWT_SECRET", "dev-secret-change-me")

# Fixed UUIDs so re-running reuses the same demo tenant.
NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
ORG_ID = uuid.uuid5(NS, "demo-org")
USER_ID = uuid.uuid5(NS, "demo-user")


def main() -> None:
    with psycopg.connect(ADMIN_DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO orgs (id, name) VALUES (%s, 'Demo Org') ON CONFLICT (id) DO NOTHING",
            (ORG_ID,),
        )
        cur.execute(
            """INSERT INTO users (id, email, name) VALUES (%s, 'demo@example.test', 'Demo User')
               ON CONFLICT (id) DO NOTHING""",
            (USER_ID,),
        )
        cur.execute(
            """INSERT INTO memberships (org_id, user_id, role) VALUES (%s, %s, 'owner')
               ON CONFLICT DO NOTHING""",
            (ORG_ID, USER_ID),
        )
        conn.commit()

    token = jwt.encode(
        {
            "sub": str(USER_ID),
            "org_id": str(ORG_ID),
            "role": "owner",
            "exp": dt.datetime.now(dt.UTC) + dt.timedelta(hours=24),
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    print("Demo tenant ready (org: Demo Org, user: demo@example.test).")
    print("Paste this token into the demo frontend (valid 24h):\n")
    print(token)


if __name__ == "__main__":
    main()
