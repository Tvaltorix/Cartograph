# Evidence and Status Model

## Operational fill

| Status | Mechanical meaning |
|---|---|
| gray | No applicable current-digest evidence, or prior evidence is stale. |
| green | Every blocking check for the node passed against its current digest. |
| yellow | Non-blocking warning, partial coverage, or degraded evidence. |
| red | A blocking check failed or a required connection cannot resolve. |

Humans and AI cannot directly set these values. They may add annotations or
declared expectations, which remain separately labeled.

## Purple structural-plague overlay

MVP predicate: a strongly connected component containing more than one module
sets `plague=true` on those modules and cites `cyclic-module-component`.

Later predicates may detect persistent earliest-failing ancestors or repeated
boundary violations, but only after fixture-backed thresholds exist. Purple
must be reproducible, explainable, and self-clearing.

## Gaps

A gap exists only relative to evidence:

- unresolved internal import;
- declared target absent;
- declared edge with no static or observed counterpart;
- extractor coverage unknown, represented as a coverage gap rather than defect.
