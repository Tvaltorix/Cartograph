from cartograph.analysis import bounded_neighbors, shortest_path


GRAPH = {
    "nodes": [{"id": value} for value in "abcd"],
    "edges": [
        {"id": "ab", "source": "a", "target": "b"},
        {"id": "bc", "source": "b", "target": "c"},
        {"id": "cd", "source": "c", "target": "d"},
    ],
}


def test_queries_are_bounded() -> None:
    assert shortest_path(GRAPH, "a", "d", 3) == ["a", "b", "c", "d"]
    neighborhood = bounded_neighbors(GRAPH, "a", depth=99, limit=2)
    assert len(neighborhood["nodes"]) <= 2
    assert neighborhood["truncated"] is True
