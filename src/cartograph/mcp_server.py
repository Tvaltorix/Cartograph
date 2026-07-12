from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .analysis import bounded_neighbors, shortest_path
from .extract import scan_project
from .onboarding import onboard_project
from .store import DEFAULT_DB, GraphStore


mcp = FastMCP(
    "Cartograph",
    instructions="Onboard projects once, then query bounded, evidence-bound codebase graphs.",
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
LOCAL_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True)


def _store() -> GraphStore:
    return GraphStore(DEFAULT_DB)


@mcp.tool(annotations=LOCAL_WRITE)
def project_register(project: str, path: str, privacy: str = "map-only") -> dict[str, str | bool]:
    """Register a local project root. Absolute paths remain only in the local ignored database."""
    with _store() as store:
        return store.register(project, path, privacy)


@mcp.tool(annotations=LOCAL_WRITE)
def project_onboard(
    path: str,
    project: str | None = None,
    privacy: str = "map-only",
    whisper_root: str | None = None,
) -> dict[str, Any]:
    """Register, apply the explicit Whisper privacy policy, and scan a project in one operation."""
    with _store() as store:
        return onboard_project(store, path, project, privacy, whisper_root=whisper_root)


@mcp.tool(annotations=LOCAL_WRITE)
def project_scan(project: str, declarations: str | None = None) -> dict[str, Any]:
    """Explicitly rescan a registered project and store its current sanitized graph."""
    with _store() as store:
        declaration_path = declarations or store.project_declarations(project)
        graph = scan_project(store.project_root(project), project, declaration_path)
        store.save_graph(project, graph)
    return {"project": project, "graph_digest": graph["graph_digest"], **graph["summary"]}


@mcp.tool(annotations=READ_ONLY)
def project_status(project: str | None = None) -> dict[str, Any]:
    """Return graph health summaries without source text or local paths."""
    with _store() as store:
        if project is None:
            return {"projects": store.projects()}
        graph = store.load_graph(project)
    return {"project": project, "graph_digest": graph["graph_digest"], **graph["summary"]}


@mcp.tool(annotations=READ_ONLY)
def graph_neighbors(project: str, node_id: str, depth: int = 1, limit: int = 50) -> dict[str, Any]:
    """Return a bounded neighborhood, capped at depth 3 and 200 nodes."""
    with _store() as store:
        graph = store.load_graph(project)
    return bounded_neighbors(graph, node_id, depth, limit)


@mcp.tool(annotations=READ_ONLY)
def graph_path(project: str, source: str, target: str, max_depth: int = 6) -> dict[str, Any]:
    """Find a bounded undirected dependency path between two node IDs."""
    with _store() as store:
        graph = store.load_graph(project)
    return {"path": shortest_path(graph, source, target, max(1, min(max_depth, 12)))}


@mcp.tool(annotations=READ_ONLY)
def graph_gaps(project: str, limit: int = 100) -> dict[str, Any]:
    """List declared or statically detected gaps without reading source contents."""
    with _store() as store:
        graph = store.load_graph(project)
    rows = [node for node in graph["nodes"] if node["gap"]]
    return {"gaps": rows[: max(1, min(limit, 200))], "total": len(rows)}


@mcp.tool(annotations=READ_ONLY)
def graph_plague(project: str, limit: int = 100) -> dict[str, Any]:
    """List mechanically detected structural-plague nodes, currently import cycles."""
    with _store() as store:
        graph = store.load_graph(project)
    rows = [node for node in graph["nodes"] if node["plague"]]
    return {"nodes": rows[: max(1, min(limit, 200))], "total": len(rows), "rule": "strongly connected import component"}


@mcp.tool(annotations=READ_ONLY)
def graph_export(project: str, node_limit: int = 500) -> dict[str, Any]:
    """Export a bounded sanitized graph; source text and absolute roots are never included."""
    with _store() as store:
        graph = store.load_graph(project)
    limit = max(1, min(node_limit, 1000))
    nodes = graph["nodes"][:limit]
    ids = {node["id"] for node in nodes}
    return {
        "project": graph["project"],
        "graph_digest": graph["graph_digest"],
        "nodes": nodes,
        "edges": [edge for edge in graph["edges"] if edge["source"] in ids and edge["target"] in ids],
        "truncated": len(graph["nodes"]) > limit,
    }


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
