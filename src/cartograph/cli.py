from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys

from .extract import scan_project
from .model import canonical_json
from .store import DEFAULT_DB, GraphStore


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cartograph", description="Build evidence-bound codebase maps")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="local registry database")
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("register", help="register a local project root")
    register.add_argument("--name", required=True)
    register.add_argument("--path", required=True)
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
        server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(SimpleHTTPRequestHandler, directory=str(directory)))
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
            result = store.register(args.name, args.path)
        elif args.command == "scan":
            if args.path:
                store.register(args.name, args.path)
            root = store.project_root(args.name)
            graph = scan_project(root, args.name, args.declarations)
            store.save_graph(args.name, graph)
            if args.output:
                Path(args.output).write_text(canonical_json(graph), encoding="utf-8")
            result = {"project": args.name, "graph_digest": graph["graph_digest"], **graph["summary"]}
        elif args.command == "status":
            if args.name:
                graph = store.load_graph(args.name)
                result = {"project": args.name, "graph_digest": graph["graph_digest"], **graph["summary"]}
            else:
                result = {"projects": store.projects()}
        else:
            return 2
    print(canonical_json(result), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
