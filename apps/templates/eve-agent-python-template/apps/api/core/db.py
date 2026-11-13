"""Database engine and the per-request session dependency.

The engine is created lazily on first use and reused for the lifetime of the
process (Fluid compute keeps instances warm), so cold starts that never touch the
database don't pay for a connection.
"""

from collections.abc import Iterator
from threading import Lock
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine, text
from sqlmodel import Session, SQLModel, create_engine

from core.config import database_url

_engine: Engine | None = None
_engine_lock = Lock()


def build_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        # FastAPI runs sync endpoints in a thread pool.
        return create_engine(url, connect_args={"check_same_thread": False})

    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        pool_recycle=300,
        # Neon's pooled endpoint runs PgBouncer in transaction mode; don't rely on
        # server-side prepared statements surviving between transactions.
        connect_args={"prepare_threshold": None},
    )


def init_db(engine: Engine) -> None:
    """Create missing tables. Use a migration tool (e.g. Alembic) once the schema evolves."""
    import models  # noqa: F401  (registers every table on SQLModel.metadata)

    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            # Instances cold-start concurrently; serialize CREATE TABLE across them so
            # they don't race on "relation already exists". Released at commit.
            connection.execute(text("SELECT pg_advisory_xact_lock(hashtext('init_db'))"))
        SQLModel.metadata.create_all(connection)


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                engine = build_engine(database_url())
                try:
                    init_db(engine)
                except BaseException:
                    # Don't leak the pool; the next request retries from scratch.
                    engine.dispose()
                    raise
                _engine = engine
    return _engine


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
