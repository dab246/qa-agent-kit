# Contributing

## Setup

```bash
nvm use                     # Node from .nvmrc
npm ci --ignore-scripts
npm run check               # typecheck + tests + build
```

## Rules

- **Tests first for engine, gate and redaction changes.** Every change to
  classification, the driver, the release gate, redaction or the AI boundary
  needs a test that fails without it (see `tests/acceptance` and
  `tests/security`).
- **Contracts:** change the zod schema, then `npm run schemas` and commit
  `schemas/`. CI fails on drift.
- **Regexes:** anchored, bounded, no nested or overlapping quantifiers; add a
  timing test on 100 kB and 1 MB hostile inputs (see `tests/unit/core.test.ts`).
  Prefer plain string scanning.
- **No shell, no `eval`, no dynamic `import()` of configured paths.** External
  processes go through `execFile` with validated arguments.
- **Untrusted text** goes through `md()` / `xml()` before it is rendered.
- **Nothing persisted unredacted:** evidence goes through `FileEvidenceWriter`;
  new free-text fields in results must be redacted in the orchestrator.
- **Dependencies:** exact versions, at least two weeks old, justified in the PR.
- Commit messages: one line, conventional style (`feat: …`, `fix: …`).

## Layout

```text
src/        cli · orchestrator · config · core · lifecycle · permission · lanes
            evidence · reporting · release-gate · ai · adapters/{http,fake,ci}
tests/      unit · contract · acceptance · security · integration
schemas/    generated JSON Schema
examples/   minimal-permission-suite (demo app + full QA setup), ci/
prompts/    versioned AI prompt templates
docs/       architecture, threat model, configuration, policy, CI, AI, operations, ADRs
```
