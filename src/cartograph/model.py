from __future__ import annotations

from dataclasses import asdict, dataclass, field
from hashlib import sha256
import json
from typing import Any


STATUSES = {"gray", "green", "yellow", "red"}


@dataclass
class Node:
    id: str
    kind: str
    label: str
    status: str = "gray"
    status_reason: str = "not evaluated"
    path: str | None = None
    digest: str | None = None
    gap: bool = False
    plague: bool = False
    plague_reasons: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    x: int = 0
    y: int = 0


@dataclass
class Edge:
    id: str
    source: str
    target: str
    kind: str
    provenance: str
    status: str = "gray"
    status_reason: str = "not evaluated"
    plague: bool = False


@dataclass
class Evidence:
    node_id: str
    check_id: str
    digest: str
    result: str
    message: str


def canonical_json(value: Any, *, pretty: bool = True) -> str:
    separators = None if pretty else (",", ":")
    suffix = "\n" if pretty else ""
    return json.dumps(value, indent=2 if pretty else None, sort_keys=True, separators=separators) + suffix


def stable_digest(value: Any) -> str:
    return sha256(canonical_json(value, pretty=False).encode("utf-8")).hexdigest()


def graph_document(project: str, source_revision: str, nodes: list[Node], edges: list[Edge], evidence: list[Evidence]) -> dict[str, Any]:
    node_rows = sorted((asdict(node) for node in nodes), key=lambda row: row["id"])
    edge_rows = sorted((asdict(edge) for edge in edges), key=lambda row: row["id"])
    evidence_rows = sorted((asdict(item) for item in evidence), key=lambda row: (row["node_id"], row["check_id"]))
    status_counts = {status: sum(node["status"] == status for node in node_rows) for status in sorted(STATUSES)}
    document: dict[str, Any] = {
        "schema_version": "1.0",
        "project": project,
        "source_revision": source_revision,
        "nodes": node_rows,
        "edges": edge_rows,
        "evidence": evidence_rows,
        "summary": {
            "nodes": len(node_rows),
            "edges": len(edge_rows),
            "gaps": sum(bool(node["gap"]) for node in node_rows),
            "plague_nodes": sum(bool(node["plague"]) for node in node_rows),
            "statuses": status_counts,
        },
    }
    document["graph_digest"] = stable_digest(document)
    return document


def validate_graph(graph: dict[str, Any]) -> None:
    ids = {node["id"] for node in graph["nodes"]}
    if len(ids) != len(graph["nodes"]):
        raise ValueError("duplicate node id")
    evidence = {(item["node_id"], item["digest"], item["result"]) for item in graph["evidence"]}
    for node in graph["nodes"]:
        if node["status"] not in STATUSES:
            raise ValueError(f"unknown status for {node['id']}")
        if node["status"] == "green" and (node["id"], node["digest"], "pass") not in evidence:
            raise ValueError(f"green node lacks current digest evidence: {node['id']}")
    for edge in graph["edges"]:
        if edge["source"] not in ids or edge["target"] not in ids:
            raise ValueError(f"edge endpoint missing: {edge['id']}")
