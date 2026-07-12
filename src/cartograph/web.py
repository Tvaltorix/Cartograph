from __future__ import annotations

from http.server import SimpleHTTPRequestHandler
import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .extract import scan_project
from .onboarding import onboard_project
from .store import GraphStore


MAX_REQUEST_BYTES = 65_536


class CartographRequestHandler(SimpleHTTPRequestHandler):
    db_path: Path

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _payload(self) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Content-Type must be application/json")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_REQUEST_BYTES:
            raise ValueError("request body size is invalid")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/projects":
                with GraphStore(self.db_path) as store:
                    self._json(200, {"projects": store.projects()})
                return
            prefix = "/api/projects/"
            suffix = "/graph"
            if path.startswith(prefix) and path.endswith(suffix):
                project = unquote(path[len(prefix):-len(suffix)]).strip("/")
                with GraphStore(self.db_path) as store:
                    self._json(200, store.load_graph(project))
                return
        except (KeyError, ValueError) as exc:
            self._json(404, {"error": str(exc)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._payload()
            if path == "/api/onboard":
                with GraphStore(self.db_path) as store:
                    result = onboard_project(
                        store,
                        root=payload.get("path", "."),
                        name=payload.get("name"),
                        privacy=payload.get("privacy", "map-only"),
                    )
                self._json(201, result)
                return
            prefix = "/api/projects/"
            suffix = "/scan"
            if path.startswith(prefix) and path.endswith(suffix):
                project = unquote(path[len(prefix):-len(suffix)]).strip("/")
                with GraphStore(self.db_path) as store:
                    graph = scan_project(store.project_root(project), project, store.project_declarations(project))
                    store.save_graph(project, graph)
                    result = {
                        "project": project,
                        "privacy": store.project_privacy(project),
                        "graph_digest": graph["graph_digest"],
                        **graph["summary"],
                    }
                self._json(200, result)
                return
            self._json(404, {"error": "API route not found"})
        except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"error": str(exc)})


def handler_factory(directory: str | Path, db_path: str | Path) -> type[CartographRequestHandler]:
    static_root = str(Path(directory).resolve())
    database = Path(db_path)

    class BoundHandler(CartographRequestHandler):
        db_path = database

        def __init__(self, *args: Any, **kwargs: Any):
            super().__init__(*args, directory=static_root, **kwargs)

    return BoundHandler
