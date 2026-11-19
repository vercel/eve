"""Service metadata, mounted at `/v1/info`."""

import os
import platform

import fastapi
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["meta"])


class ServiceInfo(BaseModel):
    service: str
    python_version: str
    fastapi_version: str
    environment: str
    region: str | None
    deployment_url: str | None


@router.get("/info", response_model=ServiceInfo)
def info() -> ServiceInfo:
    return ServiceInfo(
        service="api",
        python_version=platform.python_version(),
        fastapi_version=fastapi.__version__,
        environment=os.environ.get("VERCEL_ENV", "local"),
        region=os.environ.get("VERCEL_REGION"),
        deployment_url=os.environ.get("VERCEL_URL"),
    )
