from __future__ import annotations

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from cartograph.web import handler_factory


def _request(url: str, method: str = "GET", payload: dict | None = None, content_type: str = "application/json") -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=body, method=method, headers={"Content-Type": content_type})
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def test_loopback_api_onboards_without_exposing_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    static = tmp_path / "static"
    static.mkdir()
    subject = tmp_path / "Subject"
    subject.mkdir()
    (subject / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    whisper = tmp_path / "Whisper"
    (whisper / "context").mkdir(parents=True)
    (whisper / "context" / "sources.example.json").write_text(
        '{"sources": [], "excluded_roots": [], "excluded_aliases": []}', encoding="utf-8"
    )
    monkeypatch.setenv("WHISPER_ROOT", str(whisper))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory(static, tmp_path / "web.sqlite3"))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        onboarded = _request(
            f"{base}/api/onboard", "POST", {"path": str(subject), "privacy": "shared"}
        )
        assert onboarded["project"] == "subject"
        projects = _request(f"{base}/api/projects")
        assert projects["projects"][0]["privacy"] == "shared"
        assert str(subject) not in json.dumps(projects)
        graph = _request(f"{base}/api/projects/subject/graph")
        assert graph["project"] == "subject"
        refreshed = _request(f"{base}/api/projects/subject/scan", "POST", {})
        assert refreshed["graph_digest"] == graph["graph_digest"]
        with pytest.raises(HTTPError) as error:
            _request(f"{base}/api/onboard", "POST", {"path": str(subject)}, "text/plain")
        assert error.value.code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
