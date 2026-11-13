from datetime import UTC, datetime

from pydantic import field_validator, model_validator
from sqlalchemy import DateTime
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(UTC)


def strip_title(value: object) -> object:
    # Strip before min_length runs so whitespace-only titles are rejected.
    return value.strip() if isinstance(value, str) else value


class TaskBase(SQLModel):
    title: str = Field(min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)

    _strip_title = field_validator("title", mode="before")(strip_title)


class Task(TaskBase, table=True):
    """The `tasks` table."""

    __tablename__ = "tasks"

    id: int | None = Field(default=None, primary_key=True)
    completed: bool = Field(default=False, index=True)
    created_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False
    )
    updated_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False
    )


class TaskCreate(TaskBase):
    pass


class TaskUpdate(SQLModel):
    """Partial update: only the fields present in the request body change."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)
    completed: bool | None = None

    _strip_title = field_validator("title", mode="before")(strip_title)

    @model_validator(mode="after")
    def reject_explicit_nulls(self) -> "TaskUpdate":
        for name in ("title", "completed"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class TaskRead(TaskBase):
    id: int
    completed: bool
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def assume_utc(cls, value: datetime) -> datetime:
        # SQLite drops the offset; values are always written in UTC.
        return value if value.tzinfo else value.replace(tzinfo=UTC)
