from __future__ import annotations

import json
from datetime import UTC, datetime
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
        project_columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(projects)")}
        if "privacy" not in project_columns:
            self.connection.execute("ALTER TABLE projects ADD COLUMN privacy TEXT NOT NULL DEFAULT 'map-only'")
        if "declarations" not in project_columns:
            self.connection.execute("ALTER TABLE projects ADD COLUMN declarations TEXT")
        graph_columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(graphs)")}
        if "scanned_at" not in graph_columns:
            self.connection.execute("ALTER TABLE graphs ADD COLUMN scanned_at TEXT")
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def register(
        self,
        name: str,
        root: str | Path,
        privacy: str = "map-only",
        declarations: str | Path | None = None,
    ) -> dict[str, str | bool]:
        path = Path(root).resolve()
        if not path.is_dir():
            raise ValueError("project root must be a directory")
        if privacy not in {"shared", "map-only", "private"}:
            raise ValueError("privacy must be shared, map-only, or private")
        declarations_path = Path(declarations).expanduser().resolve() if declarations else None
        if declarations_path is not None and not declarations_path.is_file():
            raise ValueError("declarations must be an existing JSON file")
        existing = self.connection.execute(
            "SELECT name FROM projects WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if existing is not None and existing["name"] != name:
            self.connection.execute(
                "INSERT OR IGNORE INTO projects(name, root, privacy, declarations) "
                "SELECT ?, root, privacy, declarations FROM projects WHERE name = ?",
                (name, existing["name"]),
            )
            self.connection.execute("UPDATE graphs SET project = ? WHERE project = ?", (name, existing["name"]))
            self.connection.execute("DELETE FROM projects WHERE name = ?", (existing["name"],))
        self.connection.execute(
            "INSERT INTO projects(name, root, privacy, declarations) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET root=excluded.root, privacy=excluded.privacy, "
            "declarations=COALESCE(excluded.declarations, projects.declarations)",
            (name, str(path), privacy, str(declarations_path) if declarations_path else None),
        )
        self.connection.commit()
        return {"project": name, "privacy": privacy, "registered": True}

    def project_root(self, name: str) -> Path:
        row = self.connection.execute("SELECT root FROM projects WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if row is None:
            raise KeyError(f"project is not registered: {name}")
        return Path(row["root"])

    def project_privacy(self, name: str) -> str:
        row = self.connection.execute("SELECT privacy FROM projects WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if row is None:
            raise KeyError(f"project is not registered: {name}")
        return row["privacy"]

    def project_declarations(self, name: str) -> Path | None:
        row = self.connection.execute(
            "SELECT declarations FROM projects WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row is None:
            raise KeyError(f"project is not registered: {name}")
        return Path(row["declarations"]) if row["declarations"] else None

    def save_graph(self, name: str, graph: dict) -> None:
        scanned_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.connection.execute(
            "INSERT INTO graphs(project, graph_digest, payload, scanned_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(project) DO UPDATE SET graph_digest=excluded.graph_digest, "
            "payload=excluded.payload, scanned_at=excluded.scanned_at",
            (name, graph["graph_digest"], json.dumps(graph, sort_keys=True), scanned_at),
        )
        self.connection.commit()

    def load_graph(self, name: str) -> dict:
        row = self.connection.execute("SELECT payload FROM graphs WHERE project = ? COLLATE NOCASE", (name,)).fetchone()
        if row is None:
            raise KeyError(f"project has not been scanned: {name}")
        return json.loads(row["payload"])

    def projects(self) -> list[dict[str, str | None]]:
        rows = self.connection.execute(
            "SELECT p.name, p.privacy, g.graph_digest, g.scanned_at "
            "FROM projects p LEFT JOIN graphs g ON p.name = g.project ORDER BY p.name"
        ).fetchall()
        return [
            {
                "project": row["name"],
                "privacy": row["privacy"],
                "graph_digest": row["graph_digest"],
                "scanned_at": row["scanned_at"],
            }
            for row in rows
        ]

    def __enter__(self) -> "GraphStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
