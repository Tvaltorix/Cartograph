# Architecture

## Pipeline

```text
explicit project registration
        -> safe file inventory
        -> per-file digest + extractor
        -> canonical nodes/edges/evidence
        -> status + gap + plague evaluation
        -> deterministic layout + JSON export
        -> SQLite projection
        -> MCP queries / browser viewer
```

## Layers

1. `model`: immutable graph records and deterministic serialization.
2. `extractors`: language/domain adapters that return claims with provenance.
3. `analysis`: resolution, status, gaps, strongly connected components, plague.
4. `layout`: stable coordinates based on semantic lanes and sorted identity.
5. `store`: local project registry and current graph projection.
6. `mcp_server`: bounded model-controlled queries and explicit mutations.
7. `viewer`: human inspection of the same exported graph.

## Provenance

- `static`: parsed from subject source.
- `declared`: manifest/config/architecture expectation.
- `observed`: test, runtime, or health evidence.
- `inferred`: human/AI hypothesis; never sufficient for computed status.

## Authority and freshness

Subject source and tests remain canonical. Each evidence row binds a check to a
content digest. A changed digest invalidates prior green. A failed or interrupted
scan never replaces the last complete generation; consumers see it as stale.

## Security boundary

Registration is explicit. Scans reject paths outside the registered root,
outside-root symlinks, sensitive filenames, large files, and excluded trees.
Exports use relative POSIX paths and omit source bodies and absolute roots.
