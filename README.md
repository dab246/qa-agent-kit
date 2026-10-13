# QA Agent Kit

Evidence-driven QA for pull requests. The kit routes a change, checks that the
expectations it enforces come from approved sources, runs deterministic
permission probes against the system under test, ingests other test lanes,
writes sanitized evidence, and decides **GO / NO_GO** with an explicit release
policy. AI can propose tests and triage failures, but it never decides a result
or the release.

> AI may propose a conclusion; PASS/FAIL and release eligibility come only from
> validated test results and policy.

## Quick start

```bash
npm ci --ignore-scripts
npm run check          # typecheck + tests + build
npm run demo           # example app, correct      → GO (exit 0)
npm run demo:bug       # example app, injected bug → NO_GO (exit 1), V2 privilege escalation
```

Each run writes `artifacts/demo/<run-id>/` with `report.md`, `summary.md`,
`gate.json`, `run.json`, `junit.xml` and `evidence/`.

Start your own suite:

```bash
npx qa-agent-kit init qa              # scaffold from the example suite
npx qa-agent-kit validate -c qa/qa-agent-kit.yaml
npx qa-agent-kit run -c qa/qa-agent-kit.yaml --base origin/main
```

## How it maps to the two diagrams

| Diagram step | Kit |
| --- | --- |
| 1. Initialization and routing (S0, Path A/B/C/D) | `qa-route.yaml` + `routing.paths` in the config |
| 2. Phase 0: source validation | `source-manifest.yaml`, sha256-pinned sources, `sources check / rehash` |
| 3. Phase 1: test packs, manual E2E | Markdown test packs (source of truth), `manual-results.yaml` |
| 4. Execution lanes (API/UI/NFR) | permission lane (built in) + any lane through JUnit XML intake |
| 5. Release gate | deterministic policy evaluator, exit codes for CI |
| Change loop | `impact.rules` (unknown impact ⇒ run everything), Phase 0 re-opened on source change |
| Permission engine: seeding, matrices, actors, gates registry, shared driver, reporting | `permission/driver.ts`, matrices, `target.yaml` operation allowlist, actor bootstrap, evidence + report |
| V1 / V2 / V3 / SKIP / ALLOW | PASS (denial) / FAIL `PRIVILEGE_ESCALATION` / INCONCLUSIVE / INCONCLUSIVE `NO_EXPECTATION` / PASS (allow) |

## Commands

| Command | Purpose |
| --- | --- |
| `init <dir>` | Scaffold a suite from `examples/minimal-permission-suite` |
| `validate` | Validate config, matrices, test packs, target declarations (no network, no secrets) |
| `run` | Full pipeline; `--ci github` binds to the PR head and publishes a summary with `--summary` |
| `gate --run <dir>` | Re-evaluate a recorded run after manual E2E, intake or approval changes |
| `impact` | Show which matrices a change selects |
| `sources check \| rehash` | Phase 0 check; re-pin changed files and drop approval to PENDING |
| `proposal review --proposal <file>` | Review an AI test proposal (never edits a matrix) |
| `triage --run <dir> [--import <file>]` | Deterministic failure grouping; validate an AI triage |

Exit codes: `0` GO · `1` NO_GO (definite failure) · `2` NO_GO (needs review:
blocked, inconclusive, missing evidence or approval) · `3` invalid input ·
`4` internal error. CI must treat every non-zero code as a failed check.

## Documentation

- [Architecture](docs/architecture.md) and [ADRs](docs/adr/)
- [Permission testing](docs/permission-testing.md)
- [Configuration](docs/configuration.md)
- [Release policy](docs/release-policy.md)
- [CI integration](docs/ci-integration.md)
- [AI assistance](docs/ai.md)
- [Threat model](docs/threat-model.md) and [SECURITY.md](SECURITY.md)
- [Operations](docs/operations.md)

## Status

MVP of the plan's milestones M0–M3 with the M5 advisory AI boundary: contracts,
permission engine, fake and generic HTTP/GraphQL adapters, evidence, reports,
release gate, CLI and a GitHub Actions adapter. Still open (plan §19): the real
target application and its auth model, the CI provider of the target repository
and how test accounts and fixtures are provisioned.
