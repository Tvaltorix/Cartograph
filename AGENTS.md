# Cartograph Agent Instructions

Cartograph is a read-only codebase observability system. It discovers structure,
records evidence, and renders a rebuildable graph; it never edits a subject
repository or treats its projection as canonical truth.

## Required workflow

1. Read `docs/PROJECT_PACKET.md` and the active plan under `docs/plans/`.
2. Inspect before editing. Keep changes small, reversible, and independently testable.
3. Separate discovered structure, declared expectations, observed evidence, and inference.
4. A node is never green without a named check against its current digest.
5. AI and humans may annotate or nominate; only deterministic predicates assign status.
6. Store no subject absolute paths, secrets, source contents, or private names in exports.
7. Run `python -m pytest` and the documented smoke commands before claiming completion.

## Coding contract

- Runtime: Python 3.11+ for extraction/MCP; browser-native HTML/CSS/JavaScript for the viewer.
- Prefer standard-library implementations until a dependency materially improves correctness.
- Public APIs and data models require type hints and focused tests.
- Lead reviews with correctness, security/privacy, edge cases, tests, maintainability, then performance.
- Commit and push only from this repository.

## Authority

Subject source/tests/config > Cartograph evidence > graph projection > annotations.
Valtor's committed JSONL is the build ledger for this repository only.
