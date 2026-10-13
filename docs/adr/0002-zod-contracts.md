# ADR 0002: zod contracts as the single source of schemas

Status: accepted

## Decision

Every file format is a strict zod schema in `src/`; `schemas/*.json` is
generated from it (`npm run schemas`) and a contract test fails on drift.
Unknown keys are rejected everywhere.

## Consequences

Types, runtime validation and published JSON Schema cannot disagree. A typo in
a matrix is an error, not an ignored field.
