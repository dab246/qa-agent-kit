# Configuration

All files are YAML or JSON, versioned with `schemaVersion: 1`, and validated
against `schemas/*.schema.json` (add `# yaml-language-server: $schema=...` for
editor support). Paths are relative to `qa-agent-kit.yaml`. Unknown keys are
errors.

| File | Schema | Owner |
| --- | --- | --- |
| `qa-agent-kit.yaml` | `project-config` | QA Lead |
| `target.yaml` | `http-target` | QA engineer + service owner |
| `matrices/*.yaml` | `permission-matrix` | QA engineer, reviewed against sources |
| `source-manifest.yaml` | `source-manifest` | QA Lead (Phase 0 approval) |
| `qa-route.yaml` | `qa-route` | QA Lead (S0: path, owner, gaps, intake, cost/value) |
| `test-packs/*.md` | Markdown (below) | QA engineer |
| `manual-results.yaml` | `manual-results` | Tester |
| `release-policy.yaml` | `release-policy` | QA Lead + release owner |

## `qa-agent-kit.yaml`

See `examples/minimal-permission-suite/qa-agent-kit.yaml`. Main sections:

- `project`: id and environment (must be in `safety.allowedEnvironments`).
- `safety`: `allowedEnvironments` (default local/test/staging), `allowedHosts`.
- `sources.manifest`, `routing` (`route` file, `paths` A/B/C/D → lanes).
- `permission`: `target`, `matrices`, `execution` (timeouts, `stopOnCriticalViolation`).
- `testPacks`: Markdown `files`, `manualResults`.
- `lanes.<name>`: `junit` report paths, `required`.
- `impact`: `rules` (`paths` globs → `matrices`/`lanes`), `alwaysRun`,
  `onUnmatched: run-all` (default; unknown impact runs everything).
- `evidence`: `directory`, `includeResponseBodies` (false), `maxBodyBytes`,
  `redactHeaders`, `redactFields`.
- `releaseGate.policy`, `ai` (`allowChangeApprovedMatrix` can only be false).

## Markdown test packs (Phase 1)

```markdown
## TC-SET-002: Regular user cannot change global settings
- Type: automated          # manual-e2e | automated | review
- Lane: permission
- Priority: P1
- Required: yes
- Automation: permission:settings-permissions:regular-user-update-admin-settings
```

Required `manual-e2e` cases need a PASS in `manual-results.yaml`; required
`automated` cases must link to automated results that PASS (traceability).

Links are test keys `lane:suite:test`. Several links may share a line
(comma-separated) and `- Automation:` may repeat, one link per line, which is
how to link a test whose name contains a comma. A trailing `*` links every
test whose key starts with the text before it, e.g. a whole `describe` block:

```markdown
- Automation: unit:src/__tests__/report.test.ts:aggregateWeeklyTasks > *
```

The pattern must match at least one result, and every match must PASS.
For JUnit lanes the suite is the `<testsuite name>` and the test is the
`<testcase name>`, prefixed with `classname.` only when the classname differs
from the suite name (Vitest and Jest repeat the file path, so the test is just
the name). Run `qa-agent-kit run` once and read `run.json` to copy exact keys.

## Phase 0 source manifest

Each source has a `revision` and `status` (`VERIFIED`, `ASSUMPTION`,
`OBSOLETE`, `UNVERIFIED`), optionally a `path` pinned by `sha256`. Matrices cite
sources by id and revision. When a pinned file changes, `sources check` fails;
`sources rehash` re-pins it, marks it UNVERIFIED and sets approval to PENDING
until a reviewer approves again.
