"""FastAPI service.

This service has no public route. Vercel only reaches it through service bindings:
the eve agent's tools and the Next.js app both receive its URL as `BACKEND_URL`.
Because bindings call the service directly, routes live at the root (no path prefix).

- `/v1/*`: backend APIs for the app (and the agent's task tools).
- `/tools/*`: stateless Python tools for the agent.
"""

import math

from fastapi import APIRouter, FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from core.config import DatabaseNotConfiguredError
from routers import info, tasks, tools

app = FastAPI(
    title="eve Agent with Python",
    description="Backend APIs for the Next.js app and Python tools for the eve agent.",
    version="0.1.0",
)

v1 = APIRouter(prefix="/v1")
v1.include_router(info.router)
v1.include_router(tasks.router)

app.include_router(v1)
app.include_router(tools.router)


@app.exception_handler(DatabaseNotConfiguredError)
def database_not_configured(_request: Request, exc: DatabaseNotConfiguredError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": str(exc)}
    )


def _json_safe(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(v) for v in value]
    return value


@app.exception_handler(RequestValidationError)
def request_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Python's json accepts NaN/Infinity, and the default handler echoes the input
    # back, which then fails to serialize. Stringify those values instead.
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": _json_safe(jsonable_encoder(exc.errors()))},
    )


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}
