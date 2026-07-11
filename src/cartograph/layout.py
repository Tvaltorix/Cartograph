from __future__ import annotations

from .model import Node


LANES = ["project", "client", "mcp_server", "tool", "resource", "prompt", "database", "module", "external_dep", "expected", "gap"]
ROWS_PER_COLUMN = 10


def assign_layout(nodes: list[Node]) -> None:
    by_kind: dict[str, list[Node]] = {}
    for node in nodes:
        by_kind.setdefault(node.kind, []).append(node)
    ordered_kinds = [kind for kind in LANES if kind in by_kind] + sorted(set(by_kind) - set(LANES))
    cursor_x = 120
    for kind in ordered_kinds:
        lane_nodes = sorted(by_kind[kind], key=lambda item: item.id)
        columns = max(1, (len(lane_nodes) + ROWS_PER_COLUMN - 1) // ROWS_PER_COLUMN)
        for index, node in enumerate(lane_nodes):
            node.x = cursor_x + (index // ROWS_PER_COLUMN) * 190
            node.y = 90 + (index % ROWS_PER_COLUMN) * 76
        cursor_x += columns * 190 + 70
