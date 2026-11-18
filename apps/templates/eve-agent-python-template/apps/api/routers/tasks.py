"""CRUD API for tasks. Used by the Next.js Tasks page and the agent's task tools."""

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlmodel import Session, col, select

from core.db import SessionDep
from models import Task, TaskCreate, TaskRead, TaskUpdate
from models.task import utcnow

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _get_or_404(session: Session, task_id: int) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


@router.get("", response_model=list[TaskRead])
def list_tasks(
    session: SessionDep,
    completed: bool | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[Task]:
    """Open tasks first, then newest first."""
    statement = select(Task)
    if completed is not None:
        statement = statement.where(Task.completed == completed)
    statement = (
        statement.order_by(col(Task.completed), col(Task.created_at).desc(), col(Task.id).desc())
        .offset(offset)
        .limit(limit)
    )
    return list(session.exec(statement).all())


@router.post("", response_model=TaskRead, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreate, session: SessionDep) -> Task:
    task = Task.model_validate(body)
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: int, session: SessionDep) -> Task:
    return _get_or_404(session, task_id)


@router.patch("/{task_id}", response_model=TaskRead)
def update_task(task_id: int, body: TaskUpdate, session: SessionDep) -> Task:
    task = _get_or_404(session, task_id)
    task.sqlmodel_update(body.model_dump(exclude_unset=True))
    task.updated_at = utcnow()
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: int, session: SessionDep) -> Response:
    session.delete(_get_or_404(session, task_id))
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
