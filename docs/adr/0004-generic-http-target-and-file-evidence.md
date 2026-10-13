# ADR 0004: Generic HTTP target and file-based evidence

Status: accepted

## Decision

The first real adapter is a declarative REST/GraphQL target (`target.yaml`),
so a team can start without code; other protocols implement `Target`. Evidence
is one redacted JSON file per result plus a sha256 index, inside the run
directory that CI uploads. Bodies are omitted by default.

## Consequences

No external storage until retention or scale demands it. Integrity of a run can
be verified offline (`gate` re-checks checksums).
