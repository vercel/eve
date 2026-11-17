import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_info() -> None:
    response = client.get("/v1/info")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "api"
    assert body["python_version"].startswith("3.")


def test_stats() -> None:
    response = client.post("/tools/stats", json={"numbers": [3, 5, 9, 9]})
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 4
    assert body["sum"] == 26
    assert body["mean"] == 6.5
    assert body["median"] == 7
    assert body["modes"] == [9]
    assert body["range"] == 6
    assert body["quartiles"] == [4.5, 7.0, 9.0]


def test_stats_single_value() -> None:
    body = client.post("/tools/stats", json={"numbers": [42]}).json()
    assert body["mean"] == 42
    assert body["stdev"] is None
    assert body["quartiles"] is None


def test_stats_rejects_empty() -> None:
    assert client.post("/tools/stats", json={"numbers": []}).status_code == 422


def test_analyze_text() -> None:
    text = "The cat sat on the mat. The cat was happy!\n\nA new paragraph."
    response = client.post("/tools/analyze-text", json={"text": text, "top_n": 3})
    assert response.status_code == 200
    body = response.json()
    assert body["words"] == 13
    assert body["sentences"] == 3
    assert body["paragraphs"] == 2
    assert body["top_words"][0] == {"word": "cat", "count": 2}
    assert len(body["top_words"]) == 3


def test_analyze_text_rejects_empty() -> None:
    assert client.post("/tools/analyze-text", json={"text": ""}).status_code == 422


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity"])
def test_stats_rejects_non_finite(raw: str) -> None:
    # json.loads accepts these tokens, so send the body raw.
    response = client.post(
        "/tools/stats",
        content=f'{{"numbers": [1, {raw}]}}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


def test_stats_rejects_overflow() -> None:
    response = client.post("/tools/stats", json={"numbers": [1e308, 1e308]})
    assert response.status_code == 422
    assert "overflow" in response.json()["detail"]
