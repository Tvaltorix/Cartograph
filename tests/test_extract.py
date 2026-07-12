from __future__ import annotations

import json
from pathlib import Path

from cartograph.extract import scan_project
from cartograph.model import canonical_json, validate_graph


def _fixture(root: Path) -> Path:
    package = root / "pkg"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "a.py").write_text("from . import b\n", encoding="utf-8")
    (package / "b.py").write_text("from . import a\n", encoding="utf-8")
    (root / "server.py").write_text(
        "from mcp.server.fastmcp import FastMCP\n"
        "mcp = FastMCP('Fixture MCP')\n"
        "@mcp.tool()\n"
        "def ping() -> str:\n"
        "    return 'pong'\n",
        encoding="utf-8",
    )
    declarations = root / "declarations.json"
    declarations.write_text(
        json.dumps({"nodes": [{"id": "expected:runtime", "kind": "expected", "label": "Runtime evidence"}]}),
        encoding="utf-8",
    )
    return declarations


def test_scan_is_deterministic_evidence_bound_and_private(tmp_path: Path) -> None:
    declarations = _fixture(tmp_path)
    first = scan_project(tmp_path, "fixture", declarations)
    second = scan_project(tmp_path, "fixture", declarations)
    assert canonical_json(first) == canonical_json(second)
    validate_graph(first)
    assert all(node["digest"] for node in first["nodes"] if node["status"] == "green")
    assert str(tmp_path) not in canonical_json(first)
    assert next(node for node in first["nodes"] if node["id"] == "expected:runtime")["gap"] is True
    assert {node["id"] for node in first["nodes"] if node["plague"]} == {"module:pkg.a", "module:pkg.b"}
    assert any(node["kind"] == "mcp_server" for node in first["nodes"])
    assert any(node["kind"] == "tool" and node["label"] == "ping" for node in first["nodes"])


def test_parse_failure_is_red(tmp_path: Path) -> None:
    (tmp_path / "broken.py").write_text("def nope(:\n", encoding="utf-8")
    graph = scan_project(tmp_path, "broken")
    node = next(node for node in graph["nodes"] if node["id"] == "module:broken")
    assert node["status"] == "red"
    assert any(item["node_id"] == node["id"] and item["result"] == "fail" for item in graph["evidence"])


def test_unresolved_relative_import_is_a_red_gap(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "uses_missing.py").write_text("from .missing import value\n", encoding="utf-8")
    graph = scan_project(tmp_path, "missing")
    gaps = [node for node in graph["nodes"] if node["gap"]]
    assert len(gaps) == 1
    assert gaps[0]["status"] == "red"


def test_package_initializer_relative_import_resolves_inside_package(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    package.mkdir()
    (package / "__init__.py").write_text("from .module import VALUE\n", encoding="utf-8")
    (package / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    graph = scan_project(tmp_path, "package")
    assert not [node for node in graph["nodes"] if node["gap"]]
    assert any(
        edge["source"] == "module:pkg" and edge["target"] == "module:pkg.module"
        for edge in graph["edges"]
    )


def test_cycle_disappears_when_dependency_is_removed(tmp_path: Path) -> None:
    declarations = _fixture(tmp_path)
    before = scan_project(tmp_path, "fixture", declarations)
    assert before["summary"]["plague_nodes"] == 2
    (tmp_path / "pkg" / "b.py").write_text("VALUE = 1\n", encoding="utf-8")
    after = scan_project(tmp_path, "fixture", declarations)
    assert after["summary"]["plague_nodes"] == 0
