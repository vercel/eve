import pytest
from fastapi.testclient import TestClient

from core import config, db


def create(client: TestClient, title: str, **fields: object) -> dict:
    response = client.post("/v1/tasks", json={"title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_create_and_get(client: TestClient) -> None:
    task = create(client, "Write docs", notes="README first")
    assert task["id"] > 0
    assert task["completed"] is False
    assert task["created_at"].endswith(("Z", "+00:00"))

    fetched = client.get(f"/v1/tasks/{task['id']}").json()
    assert fetched == task


def test_list_orders_open_first_then_newest(client: TestClient) -> None:
    first = create(client, "first")
    second = create(client, "second")
    done = create(client, "done")
    client.patch(f"/v1/tasks/{done['id']}", json={"completed": True})

    titles = [t["title"] for t in client.get("/v1/tasks").json()]
    assert titles == ["second", "first", "done"]

    open_only = client.get("/v1/tasks", params={"completed": False}).json()
    assert {t["id"] for t in open_only} == {first["id"], second["id"]}

    page = client.get("/v1/tasks", params={"limit": 1, "offset": 1}).json()
    assert [t["title"] for t in page] == ["first"]


def test_partial_update(client: TestClient) -> None:
    task = create(client, "Ship it", notes="soon")
    updated = client.patch(f"/v1/tasks/{task['id']}", json={"completed": True}).json()
    assert updated["completed"] is True
    assert updated["title"] == "Ship it"
    assert updated["notes"] == "soon"
    assert updated["updated_at"] >= task["updated_at"]

    cleared = client.patch(f"/v1/tasks/{task['id']}", json={"notes": None}).json()
    assert cleared["notes"] is None


def test_update_rejects_null_title(client: TestClient) -> None:
    task = create(client, "Keep title")
    response = client.patch(f"/v1/tasks/{task['id']}", json={"title": None})
    assert response.status_code == 422


def test_delete(client: TestClient) -> None:
    task = create(client, "Temporary")
    assert client.delete(f"/v1/tasks/{task['id']}").status_code == 204
    assert client.get(f"/v1/tasks/{task['id']}").status_code == 404
    assert client.delete(f"/v1/tasks/{task['id']}").status_code == 404


@pytest.mark.parametrize("body", [{"title": ""}, {"title": "x" * 201}, {}])
def test_create_validation(client: TestClient, body: dict) -> None:
    assert client.post("/v1/tasks", json=body).status_code == 422


def test_missing_task_is_404(client: TestClient) -> None:
    assert client.get("/v1/tasks/999").status_code == 404
    assert client.patch("/v1/tasks/999", json={"completed": True}).status_code == 404


def test_deployment_without_database_returns_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    monkeypatch.setattr(db, "_engine", None)

    from main import app

    response = TestClient(app).get("/v1/tasks")
    assert response.status_code == 503
    assert "DATABASE_URL" in response.json()["detail"]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "postgres://u:p@host/db?sslmode=require",
            "postgresql+psycopg://u:p@host/db?sslmode=require",
        ),
        ("postgresql://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
        ("postgresql+psycopg://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
    ],
)
def test_normalize_postgres_url(url: str, expected: str) -> None:
    assert config.normalize_postgres_url(url) == expected


def test_create_rejects_blank_title(client: TestClient) -> None:
    response = client.post("/v1/tasks", json={"title": "   "})
    assert response.status_code == 422


def test_create_strips_title(client: TestClient) -> None:
    assert create(client, "  Padded  ")["title"] == "Padded"


def test_update_rejects_blank_title(client: TestClient) -> None:
    task = create(client, "Keep title")
    response = client.patch(f"/v1/tasks/{task['id']}", json={"title": " \t "})
    assert response.status_code == 422
    assert client.get(f"/v1/tasks/{task['id']}").json()["title"] == "Keep title"
