from __future__ import annotations

import json
from pathlib import Path
import sqlite3


DEFAULT_DB = Path.home() / ".cartograph" / "cartograph.sqlite3"


class GraphStore:
    def __init__(self, path: str | Path = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, root TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS graphs (
                project TEXT PRIMARY KEY,
                graph_digest TEXT NOT NULL,
                payload TEXT NOT NULL,
                FOREIGN KEY(project) REFERENCES projects(name)
            );
            """
        )

    def close(self) -> None:
        self.connection.close()

    def register(self, name: str, root: str | Path) -> dict[str, str | bool]:
        path = Path(root).resolve()
        if not path.is_dir():
            raise ValueError("project root must be a directory")
        self.connection.execute(
            "INSERT INTO projects(name, root) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET root=excluded.root",
            (name, str(path)),
        )
        self.connection.commit()
        return {"project": name, "registered": True}

    def project_root(self, name: str) -> Path:
        row = self.connection.execute("SELECT root FROM projects WHERE name = ?", (name,)).fetchone()
        if row is None:
            raise KeyError(f"project is not registered: {name}")
        return Path(row["root"])

    def save_graph(self, name: str, graph: dict) -> None:
        self.connection.execute(
            "INSERT INTO graphs(project, graph_digest, payload) VALUES(?, ?, ?) "
            "ON CONFLICT(project) DO UPDATE SET graph_digest=excluded.graph_digest, payload=excluded.payload",
            (name, graph["graph_digest"], json.dumps(graph, sort_keys=True)),
        )
        self.connection.commit()

    def load_graph(self, name: str) -> dict:
        row = self.connection.execute("SELECT payload FROM graphs WHERE project = ?", (name,)).fetchone()
        if row is None:
            raise KeyError(f"project has not been scanned: {name}")
        return json.loads(row["payload"])

    def projects(self) -> list[dict[str, str | None]]:
        rows = self.connection.execute(
            "SELECT p.name, g.graph_digest FROM projects p LEFT JOIN graphs g ON p.name = g.project ORDER BY p.name"
        ).fetchall()
        return [{"project": row["name"], "graph_digest": row["graph_digest"]} for row in rows]

    def __enter__(self) -> "GraphStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
