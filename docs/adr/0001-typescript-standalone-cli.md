# ADR 0001: Standalone TypeScript CLI

Status: accepted

## Context

The plan selected a standalone repository, TypeScript and PR-triggered runs.
The target application, CI provider and identity provider are not confirmed.

## Decision

A Node.js (>= 22.12, CI pinned by `.nvmrc`) ESM CLI with strict TypeScript,
three runtime dependencies (`zod`, `yaml`, `fast-xml-parser`) and Vitest. No
database, queue or server: runs are files under an artifact directory.

## Consequences

Any CI that can run Node can use it. Provider- and target-specific code is
isolated behind `CiAdapter` and `Target`.
