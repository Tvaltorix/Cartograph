from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any

from .extract import scan_project
from .store import GraphStore


PRIVACY_MODES = {"shared", "map-only", "private"}


def canonical_alias(value: str) -> str:
    alias = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not alias:
        raise ValueError("project name must contain a letter or number")
    return alias[:80]


def discover_whisper_root(explicit: str | Path | None = None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    if os.getenv("WHISPER_ROOT"):
        candidates.append(Path(os.environ["WHISPER_ROOT"]))
    repository = Path(__file__).resolve().parents[2]
    candidates.extend((repository.parent / "Whisper", Path.home() / "Whisper"))
    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        if (resolved / "context" / "sources.example.json").is_file():
            return resolved
    return None


def _same_path(left: str | Path, right: Path) -> bool:
    try:
        return os.path.normcase(str(Path(left).expanduser().resolve())) == os.path.normcase(str(right.resolve()))
    except (OSError, ValueError):
        return False


def update_whisper_policy(alias: str, root: Path, privacy: str, whisper_root: str | Path | None = None) -> str:
    if privacy not in PRIVACY_MODES:
        raise ValueError("privacy must be shared, map-only, or private")
    whisper = discover_whisper_root(whisper_root)
    if whisper is None:
        if privacy == "map-only":
            return "not-configured"
        raise FileNotFoundError("Whisper was not found; pass --whisper-root or set WHISPER_ROOT")
    context_dir = whisper / "context"
    local_path = context_dir / "sources.local.json"
    template_path = context_dir / "sources.example.json"
    source_path = local_path if local_path.is_file() else template_path
    data = json.loads(source_path.read_text(encoding="utf-8"))
    sources = [
        row for row in data.get("sources", [])
        if canonical_alias(str(row.get("alias", "source"))) != alias and not _same_path(row.get("root", ""), root)
    ]
    excluded_roots = [value for value in data.get("excluded_roots", []) if not _same_path(value, root)]
    excluded_aliases = [value for value in data.get("excluded_aliases", []) if canonical_alias(str(value)) != alias]
    if privacy == "shared":
        kind = "brain" if _same_path(root, whisper) else "project"
        sources.append({"alias": alias, "root": str(root), "kind": kind, "enabled": True})
        policy = "enrolled"
    elif privacy == "private":
        excluded_roots.append(str(root))
        excluded_aliases.append(alias)
        policy = "denied"
    else:
        policy = "not-enrolled"
    updated = {
        "sources": sorted(sources, key=lambda row: str(row.get("alias", ""))),
        "excluded_roots": sorted(set(excluded_roots), key=os.path.normcase),
        "excluded_aliases": sorted(set(excluded_aliases)),
    }
    context_dir.mkdir(parents=True, exist_ok=True)
    temporary = local_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(updated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(local_path)
    return policy


def onboard_project(
    store: GraphStore,
    root: str | Path = ".",
    name: str | None = None,
    privacy: str = "map-only",
    declarations: str | Path | None = None,
    whisper_root: str | Path | None = None,
) -> dict[str, Any]:
    project_root = Path(root).expanduser().resolve()
    if not project_root.is_dir():
        raise ValueError("project root must be a directory")
    if privacy not in PRIVACY_MODES:
        raise ValueError("privacy must be shared, map-only, or private")
    alias = canonical_alias(name or project_root.name)
    whisper_policy = update_whisper_policy(alias, project_root, privacy, whisper_root)
    store.register(alias, project_root, privacy, declarations)
    graph = scan_project(project_root, alias, declarations)
    store.save_graph(alias, graph)
    return {
        "project": alias,
        "privacy": privacy,
        "whisper_policy": whisper_policy,
        "graph_digest": graph["graph_digest"],
        **graph["summary"],
        "next": "$start in Codex or /start in Claude Code",
    }
