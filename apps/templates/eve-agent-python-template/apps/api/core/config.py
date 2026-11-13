"""Runtime configuration read from the environment."""

import os
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
LOCAL_SQLITE_PATH = API_ROOT / ".data" / "dev.sqlite3"


class DatabaseNotConfiguredError(RuntimeError):
    """Raised on a Vercel deployment that has no database connection string."""


def is_deployed() -> bool:
    return os.environ.get("VERCEL_ENV") in {"preview", "production"}


def database_url() -> str:
    """The SQLAlchemy URL for the backend database.

    - `DATABASE_URL` (set by the Neon integration on Vercel) or `POSTGRES_URL` when present.
    - Otherwise, locally, a SQLite file under `apps/api/.data/`.
    - Otherwise, on a deployment, fail instead of writing to an ephemeral filesystem.
    """
    url = (os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or "").strip()
    if url:
        return normalize_postgres_url(url)

    if is_deployed():
        raise DatabaseNotConfiguredError(
            "DATABASE_URL is not set. Add a Postgres database (for example Neon from the "
            "Vercel Marketplace) to this project and redeploy."
        )

    LOCAL_SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{LOCAL_SQLITE_PATH}"


def normalize_postgres_url(url: str) -> str:
    """Point `postgres://` and `postgresql://` URLs at the psycopg 3 driver."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url.removeprefix(prefix)
    return url
