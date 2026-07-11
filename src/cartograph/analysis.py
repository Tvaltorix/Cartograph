from __future__ import annotations

from collections import defaultdict, deque

from .model import Edge, Node


def mark_cycles(nodes: list[Node], edges: list[Edge]) -> None:
    module_ids = {node.id for node in nodes if node.kind == "module"}
    adjacency: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge.kind == "imports" and edge.source in module_ids and edge.target in module_ids:
            adjacency[edge.source].append(edge.target)
    index = 0
    stack: list[str] = []
    on_stack: set[str] = set()
    indices: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    components: list[list[str]] = []

    def visit(node_id: str) -> None:
        nonlocal index
        indices[node_id] = lowlinks[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)
        for target in sorted(adjacency[node_id]):
            if target not in indices:
                visit(target)
                lowlinks[node_id] = min(lowlinks[node_id], lowlinks[target])
            elif target in on_stack:
                lowlinks[node_id] = min(lowlinks[node_id], indices[target])
        if lowlinks[node_id] == indices[node_id]:
            component: list[str] = []
            while True:
                current = stack.pop()
                on_stack.remove(current)
                component.append(current)
                if current == node_id:
                    break
            components.append(component)

    for node_id in sorted(module_ids):
        if node_id not in indices:
            visit(node_id)
    plagued: set[str] = set()
    for component in components:
        self_loop = len(component) == 1 and component[0] in adjacency[component[0]]
        if len(component) > 1 or self_loop:
            plagued.update(component)
    node_by_id = {node.id: node for node in nodes}
    for node_id in plagued:
        node_by_id[node_id].plague = True
        node_by_id[node_id].plague_reasons = ["dependency cycle"]
    for edge in edges:
        edge.plague = edge.source in plagued and edge.target in plagued and edge.kind == "imports"


def shortest_path(graph: dict, source: str, target: str, max_depth: int = 6) -> list[str]:
    adjacency: dict[str, list[str]] = defaultdict(list)
    for edge in graph["edges"]:
        adjacency[edge["source"]].append(edge["target"])
        adjacency[edge["target"]].append(edge["source"])
    queue = deque([(source, [source])])
    seen = {source}
    while queue:
        current, path = queue.popleft()
        if current == target:
            return path
        if len(path) > max_depth:
            continue
        for neighbor in sorted(adjacency[current]):
            if neighbor not in seen:
                seen.add(neighbor)
                queue.append((neighbor, path + [neighbor]))
    return []


def bounded_neighbors(graph: dict, node_id: str, depth: int = 1, limit: int = 50) -> dict:
    depth = max(0, min(depth, 3))
    limit = max(1, min(limit, 200))
    edges_by_node: dict[str, list[dict]] = defaultdict(list)
    for edge in graph["edges"]:
        edges_by_node[edge["source"]].append(edge)
        edges_by_node[edge["target"]].append(edge)
    selected = {node_id}
    frontier = {node_id}
    selected_edges: dict[str, dict] = {}
    for _ in range(depth):
        next_frontier: set[str] = set()
        for current in sorted(frontier):
            for edge in sorted(edges_by_node[current], key=lambda row: row["id"]):
                selected_edges[edge["id"]] = edge
                next_frontier.update((edge["source"], edge["target"]))
                if len(selected | next_frontier) >= limit:
                    break
        frontier = next_frontier - selected
        selected.update(next_frontier)
        if len(selected) >= limit:
            selected = set(sorted(selected)[:limit])
            break
    nodes = [node for node in graph["nodes"] if node["id"] in selected]
    edges = [edge for edge in selected_edges.values() if edge["source"] in selected and edge["target"] in selected]
    return {"nodes": nodes, "edges": sorted(edges, key=lambda row: row["id"]), "truncated": len(selected) >= limit}
