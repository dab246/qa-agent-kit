# Security

QA Agent Kit handles test credentials, talks to live test environments and
publishes results into pull requests, so its own security is part of what it
tests. The full analysis is in [docs/threat-model.md](docs/threat-model.md).

## Reporting a vulnerability

Report privately to the repository owner. Do not open a public issue or PR that
describes an exploit. Include the version (`qa-agent-kit --version`), the input
that triggers the problem and its effect.

## Guarantees the code enforces (and the tests that prove them)

| Guarantee | Where | Test |
| --- | --- | --- |
| No PASS without an approved expectation | driver, gate | AT-05 |
| Missing, duplicate, stale, unknown or evidence-less results never produce GO | `release-gate/gate.ts` | AT-10, AT-11, AT-15, gate unit tests |
| Critical violations (privilege escalation, data disclosure) cannot be waived | gate | SEC-04 |
| An actor runs only as itself; no fallback to another actor's or anonymous credentials | driver, `HttpTarget` | SEC-01 |
| Only allowlisted operations run; matrices are data, not code | schemas (strict), operation registry | AT-06, SEC-06 |
| Credentials only from environment variables; config cannot hold them | `http/schema.ts` | contract tests |
| Secrets redacted in evidence, run record, reports, JUnit and CI summary | `evidence/redact.ts`, orchestrator | SEC-02 |
| Response bodies omitted by default; when kept, redacted then capped | evidence writer | SEC-02 |
| Untrusted text (PR titles, failure messages, API bodies) rendered inert | `reporting/escape.ts` | SEC-06 |
| No entity expansion in JUnit, YAML alias bombs rejected, input size capped | `lanes/junit.ts`, `core/files.ts` | SEC-06, hardening |
| Runs refused outside allowlisted environments, hosts and http(s) | project loader, `HttpTarget` | hardening |
| No retries of side-effecting operations | driver | runner invariants |
| Cleanup always runs, its failure is recorded and blocks | driver, gate | AT-14 |
| Evidence is checksummed; tampering is detected on re-gate | `orchestrator/regate.ts` | security tests |
| AI cannot change approved matrices, results or the gate | `ai/*`, config schema | SEC-05 |
| No shell execution; git refs validated before `execFile` | `adapters/ci/ci.ts` | hardening |
| Every regex is anchored with bounded, non-overlapping quantifiers; globs use an NFA | `core/*` | linear-time tests (1 MB inputs) |

## Operating rules

- Use dedicated, least-privilege **test** accounts. Never production credentials.
- Store credentials only in the CI secret store; pass them as environment variables.
- Keep `safety.allowedEnvironments` and `safety.allowedHosts` tight.
- Run the PR workflow on `pull_request`, never `pull_request_target`; pin actions by commit SHA.
- Review every change to matrices, `target.yaml`, release policy and source
  manifest like code (CODEOWNERS recommended).
- Treat run artifacts as confidential; keep retention short.

## Supply chain

- Exact dependency versions, a lockfile, `npm ci --ignore-scripts` in CI.
- `npm audit --audit-level=high` in CI; Dependabot with a 14-day cooldown.
- Three runtime dependencies only: `zod`, `yaml`, `fast-xml-parser`.
