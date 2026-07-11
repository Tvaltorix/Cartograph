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
        assert store.projects() == [{"project": "subject", "graph_digest": graph["graph_digest"]}]
        assert str(subject) not in str(store.load_graph("subject"))
        with pytest.raises(KeyError):
            store.load_graph("unknown")
