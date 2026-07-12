from pathlib import Path

import pytest

from cartograph.extract import scan_project
from cartograph.store import GraphStore


def test_store_keeps_roots_local_and_status_path_free(tmp_path: Path) -> None:
    subject = tmp_path / "subject"
    subject.mkdir()
    (subject / "ok.py").write_text("VALUE = 1\n", encoding="utf-8")
    with GraphStore(tmp_path / "cartograph.sqlite3") as store:
        store.register("subject", subject)
        graph = scan_project(subject, "subject")
        store.save_graph("subject", graph)
        [project] = store.projects()
        assert project["project"] == "subject"
        assert project["privacy"] == "map-only"
        assert project["graph_digest"] == graph["graph_digest"]
        assert project["scanned_at"]
        assert str(subject) not in str(store.load_graph("subject"))
        with pytest.raises(KeyError):
            store.load_graph("unknown")


def test_register_normalizes_existing_alias_case(tmp_path: Path) -> None:
    subject = tmp_path / "Subject"
    subject.mkdir()
    (subject / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    with GraphStore(tmp_path / "cartograph.sqlite3") as store:
        store.register("Subject", subject)
        graph = scan_project(subject, "Subject")
        store.save_graph("Subject", graph)
        store.register("subject", subject, "shared")
        assert [row["project"] for row in store.projects()] == ["subject"]
        assert store.project_privacy("SUBJECT") == "shared"
        assert store.load_graph("subject")["graph_digest"] == graph["graph_digest"]


def test_registration_preserves_declaration_path_for_refresh(tmp_path: Path) -> None:
    subject = tmp_path / "subject"
    subject.mkdir()
    declarations = tmp_path / "declarations.json"
    declarations.write_text('{"nodes": [], "edges": []}', encoding="utf-8")
    with GraphStore(tmp_path / "cartograph.sqlite3") as store:
        store.register("subject", subject, declarations=declarations)
        store.register("subject", subject, privacy="shared")
        assert store.project_declarations("subject") == declarations.resolve()
