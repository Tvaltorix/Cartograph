from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys

from .extract import scan_project
from .model import canonical_json
from .onboarding import onboard_project
from .store import DEFAULT_DB, GraphStore
from .web import handler_factory


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cartograph", description="Build evidence-bound codebase maps")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="local registry database")
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("register", help="register a local project root")
    register.add_argument("--name", required=True)
    register.add_argument("--path", required=True)
    register.add_argument("--privacy", choices=("shared", "map-only", "private"), default="map-only")
    onboard = commands.add_parser("onboard", help="register, apply privacy, and scan a project in one step")
    onboard.add_argument("path", nargs="?", default=".")
    onboard.add_argument("--name")
    privacy = onboard.add_mutually_exclusive_group()
    privacy.add_argument("--shared", action="store_true", help="enroll semantic documents in Whisper")
    privacy.add_argument("--private", action="store_true", help="deny Whisper access to this project")
    onboard.add_argument("--whisper-root")
    onboard.add_argument("--declarations")
    scan = commands.add_parser("scan", help="scan a project")
    scan.add_argument("--name", required=True)
    scan.add_argument("--path")
    scan.add_argument("--declarations")
    scan.add_argument("--output")
    status = commands.add_parser("status", help="show registered projects without local paths")
    status.add_argument("--name")
    summary = commands.add_parser("summary", help="summarize a graph file")
    summary.add_argument("--graph", required=True)
    serve = commands.add_parser("serve", help="serve the viewer and graph files")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--directory", default=".")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "serve":
        directory = Path(args.directory).resolve()
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_factory(directory, args.db))
        print(f"Cartograph viewer: http://127.0.0.1:{args.port}/viewer/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return 0
    if args.command == "summary":
        graph = json.loads(Path(args.graph).read_text(encoding="utf-8"))
        print(canonical_json({"project": graph["project"], "graph_digest": graph["graph_digest"], **graph["summary"]}), end="")
        return 0
    with GraphStore(args.db) as store:
        if args.command == "register":
            result = store.register(args.name, args.path, args.privacy)
        elif args.command == "onboard":
            privacy_mode = "shared" if args.shared else "private" if args.private else "map-only"
            result = onboard_project(
                store,
                root=args.path,
                name=args.name,
                privacy=privacy_mode,
                declarations=args.declarations,
                whisper_root=args.whisper_root,
            )
        elif args.command == "scan":
            if args.path:
                try:
                    current_privacy = store.project_privacy(args.name)
                except KeyError:
                    current_privacy = "map-only"
                store.register(args.name, args.path, current_privacy)
            root = store.project_root(args.name)
            declarations = args.declarations or store.project_declarations(args.name)
            graph = scan_project(root, args.name, declarations)
            store.save_graph(args.name, graph)
            if args.output:
                Path(args.output).write_text(canonical_json(graph), encoding="utf-8")
            result = {"project": args.name, "graph_digest": graph["graph_digest"], **graph["summary"]}
        elif args.command == "status":
            if args.name:
                graph = store.load_graph(args.name)
                result = {
                    "project": args.name,
                    "privacy": store.project_privacy(args.name),
                    "graph_digest": graph["graph_digest"],
                    **graph["summary"],
                }
            else:
                result = {"projects": store.projects()}
        else:
            return 2
    print(canonical_json(result), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
