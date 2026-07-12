from __future__ import annotations

import ast
from hashlib import sha256
import json
from pathlib import Path
from typing import Any

from .analysis import mark_cycles
from .layout import assign_layout
from .model import Edge, Evidence, Node, graph_document, stable_digest, validate_graph


SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "dist", "build", "__pycache__", ".cartograph"}
SENSITIVE_NAMES = {".env", "id_rsa", "id_ed25519", "credentials.json", "secrets.json"}
MAX_FILE_BYTES = 1_000_000


def _file_digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def _module_name(relative: Path) -> str:
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or relative.parent.name


def _python_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*.py"):
        try:
            relative = path.relative_to(root)
            if any(part in SKIP_DIRS for part in relative.parts) or path.name.lower() in SENSITIVE_NAMES:
                continue
            if path.is_symlink() and not path.resolve().is_relative_to(root.resolve()):
                continue
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            files.append(path)
        except (OSError, ValueError):
            continue
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


def _resolve_from(
    current: str,
    level: int,
    module: str | None,
    name: str | None = None,
    package_initializer: bool = False,
) -> str:
    package = current.split(".") if package_initializer else current.split(".")[:-1]
    package = package[: max(0, len(package) - level + 1)]
    parts = package + ([module] if module else []) + ([name] if name else [])
    return ".".join(part for part in parts if part)


def _decorator_parts(decorator: ast.expr) -> tuple[str, str] | None:
    candidate = decorator.func if isinstance(decorator, ast.Call) else decorator
    if isinstance(candidate, ast.Attribute) and isinstance(candidate.value, ast.Name):
        return candidate.value.id, candidate.attr
    return None


def _load_declarations(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"nodes": [], "edges": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"nodes": data.get("nodes", []), "edges": data.get("edges", [])}


def scan_project(root: str | Path, project: str | None = None, declarations: str | Path | None = None) -> dict[str, Any]:
    root_path = Path(root).resolve()
    if not root_path.is_dir():
        raise ValueError("project root must be a directory")
    project_name = project or root_path.name
    paths = _python_files(root_path)
    modules = {_module_name(path.relative_to(root_path)): path for path in paths}
    nodes: dict[str, Node] = {}
    edges: dict[str, Edge] = {}
    evidence: list[Evidence] = []
    trees: dict[str, ast.Module] = {}
    import_requests: list[tuple[str, str, bool]] = []
    servers: dict[tuple[str, str], str] = {}

    project_id = f"project:{project_name}"
    nodes[project_id] = Node(project_id, "project", project_name, status="gray", status_reason="aggregate container")
    for module, path in sorted(modules.items()):
        relative = path.relative_to(root_path).as_posix()
        data = path.read_bytes()
        digest = _file_digest(data)
        node_id = f"module:{module}"
        try:
            tree = ast.parse(data, filename=relative)
            trees[module] = tree
            nodes[node_id] = Node(node_id, "module", module, "green", "AST parsed for current digest", relative, digest)
            evidence.append(Evidence(node_id, "python.ast.parse", digest, "pass", "Python syntax parsed"))
        except (SyntaxError, UnicodeDecodeError) as exc:
            nodes[node_id] = Node(node_id, "module", module, "red", f"parse failed: {type(exc).__name__}", relative, digest)
            evidence.append(Evidence(node_id, "python.ast.parse", digest, "fail", type(exc).__name__))

    for module, tree in sorted(trees.items()):
        source_id = f"module:{module}"
        for item in ast.walk(tree):
            if isinstance(item, ast.Import):
                import_requests.extend((module, alias.name, False) for alias in item.names)
            elif isinstance(item, ast.ImportFrom):
                if item.level:
                    for alias in item.names:
                        imported_module = item.module or (None if alias.name == "*" else alias.name)
                        import_requests.append((
                            module,
                            _resolve_from(
                                module,
                                item.level,
                                imported_module,
                                package_initializer=modules[module].name == "__init__.py",
                            ),
                            True,
                        ))
                elif item.module:
                    import_requests.append((module, item.module, False))
            elif isinstance(item, (ast.Assign, ast.AnnAssign)):
                value = item.value
                if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "FastMCP":
                    targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                    for target in targets:
                        if not isinstance(target, ast.Name):
                            continue
                        label = target.id
                        if value.args and isinstance(value.args[0], ast.Constant) and isinstance(value.args[0].value, str):
                            label = value.args[0].value
                        server_id = f"mcp:{module}:{target.id}"
                        servers[(module, target.id)] = server_id
                        module_node = nodes[source_id]
                        nodes[server_id] = Node(server_id, "mcp_server", label, module_node.status, module_node.status_reason, module_node.path, module_node.digest)
                        evidence.append(Evidence(server_id, "fastmcp.constructor", module_node.digest or "", "pass", "FastMCP constructor observed"))
                        edge_id = f"edge:{server_id}:defined_in:{source_id}"
                        edges[edge_id] = Edge(edge_id, server_id, source_id, "defined_in", "observed", module_node.status, module_node.status_reason)

        for item in tree.body:
            if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in item.decorator_list:
                parts = _decorator_parts(decorator)
                if not parts or parts[1] not in {"tool", "resource", "prompt"}:
                    continue
                server_id = servers.get((module, parts[0]))
                if not server_id:
                    continue
                kind = parts[1]
                feature_id = f"{kind}:{module}:{item.name}"
                module_node = nodes[source_id]
                nodes[feature_id] = Node(feature_id, kind, item.name, module_node.status, f"FastMCP {kind} decorator observed", module_node.path, module_node.digest)
                evidence.append(Evidence(feature_id, f"fastmcp.{kind}.decorator", module_node.digest or "", "pass", f"@{parts[0]}.{kind} observed"))
                edge_id = f"edge:{server_id}:registers:{feature_id}"
                edges[edge_id] = Edge(edge_id, server_id, feature_id, "registers", "observed", module_node.status, module_node.status_reason)

    external: set[str] = set()
    for source_module, requested, relative in sorted(set(import_requests)):
        if not requested:
            continue
        candidates = [requested]
        while not relative and "." in candidates[-1]:
            candidates.append(candidates[-1].rsplit(".", 1)[0])
        target_module = next((candidate for candidate in candidates if candidate in modules), None)
        source_id = f"module:{source_module}"
        if target_module:
            target_id = f"module:{target_module}"
            target = nodes[target_id]
            status = "green" if target.status == "green" else "yellow"
            reason = "internal import resolved" if status == "green" else "import target is unhealthy"
            edge_id = f"edge:{source_id}:imports:{target_id}"
            edges[edge_id] = Edge(edge_id, source_id, target_id, "imports", "static", status, reason)
        elif relative:
            target_id = f"gap:module:{requested}"
            nodes.setdefault(target_id, Node(target_id, "gap", requested, "red", "relative import target unresolved", gap=True))
            edge_id = f"edge:{source_id}:imports:{target_id}"
            edges[edge_id] = Edge(edge_id, source_id, target_id, "imports", "static", "red", "relative import target unresolved")
        else:
            package = requested.split(".")[0]
            target_id = f"external:{package}"
            if target_id not in external:
                nodes[target_id] = Node(target_id, "external_dep", package, "gray", "external dependency not evaluated")
                external.add(target_id)
            edge_id = f"edge:{source_id}:imports:{target_id}"
            edges[edge_id] = Edge(edge_id, source_id, target_id, "imports", "static", "gray", "external dependency boundary")

    declaration_data = _load_declarations(Path(declarations) if declarations else None)
    for row in sorted(declaration_data["nodes"], key=lambda item: item["id"]):
        node_id = row["id"]
        if node_id not in nodes:
            required = row.get("required", True)
            reason = "declared but not observed" if required else "declared external boundary"
            nodes[node_id] = Node(node_id, row.get("kind", "expected"), row.get("label", node_id), "gray", reason, gap=required, metadata={"expectation": row.get("expectation", "")})
    for row in sorted(declaration_data["edges"], key=lambda item: (item["source"], item["target"], item.get("kind", "depends_on"))):
        for endpoint in (row["source"], row["target"]):
            nodes.setdefault(endpoint, Node(endpoint, "gap", endpoint, "gray", "declared endpoint not observed", gap=True))
        kind = row.get("kind", "depends_on")
        edge_id = f"edge:{row['source']}:{kind}:{row['target']}"
        edges.setdefault(edge_id, Edge(edge_id, row["source"], row["target"], kind, "declared", "gray", "declared relationship"))

    node_list = list(nodes.values())
    edge_list = list(edges.values())
    mark_cycles(node_list, edge_list)
    assign_layout(node_list)
    revision_payload = [(path.relative_to(root_path).as_posix(), _file_digest(path.read_bytes())) for path in paths]
    graph = graph_document(project_name, stable_digest(revision_payload), node_list, edge_list, evidence)
    validate_graph(graph)
    return graph
