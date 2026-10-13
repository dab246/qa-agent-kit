# Threat model

## Assets

1. **Test credentials** (passwords, tokens, OTP seeds) of the actors.
2. **Release decision integrity**: a GO must mean every mandatory condition held.
3. **Evidence and audit trail**: what ran, as whom, against which commit and sources.
4. **Test environment and its data**: the kit sends real, side-effecting requests.

## Trust boundaries

| Input | Trust | Handling |
| --- | --- | --- |
| `qa-agent-kit.yaml`, `target.yaml`, matrices, policy, manifest | Trusted after code review | Strict schemas (unknown keys rejected), no code, no credentials |
| PR title, branch, changed files | Untrusted | Escaped in reports; only used for impact selection |
| Responses of the system under test | Untrusted | Bodies omitted by default, redacted, capped; never interpreted |
| JUnit reports from other lanes | Untrusted | No entity expansion, size cap, results normalized |
| AI proposals and triage | Untrusted | Schema + semantic validation; advisory output only |
| Environment variables | Trusted (CI secret store) | Values tracked as secrets and masked verbatim |

## Threats and mitigations

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | False GO: missing, skipped, stale or duplicated results satisfy the gate | GO only when every condition holds; required keys come from the plan; duplicates, unknown statuses, other-commit results block |
| T2 | False PASS: 403 that leaks data, or 200 judged without expectation | `json-not-exists` assertions → `DATA_DISCLOSURE`; no expectation → INCONCLUSIVE; truncated body → INCONCLUSIVE |
| T3 | Privilege substitution: probe runs with a stronger identity | Actor role cross-checked (matrix ↔ target) before running; resolved identity re-checked; sessions per actor, no fallback |
| T4 | Credential leak through evidence, reports, CI summaries or AI context | Key-based, `Bearer`-based and verbatim-secret redaction on every persisted text; bodies off by default; AI context excludes bodies and inputs |
| T5 | Running against production | Environment and host allowlists, http(s) only, credentials only for test accounts |
| T6 | Injection through untrusted text (Markdown/HTML in PR comments, mentions, shell) | Escaping to inert text, HTML entities, no shell anywhere, git refs validated |
| T7 | Parser DoS: XML entities, YAML aliases, huge reports, ReDoS | Entity expansion off, alias cap, size caps, linear regexes and NFA glob (tested to 1 MB) |
| T8 | AI manipulation (prompt injection via PR text or logs) changes expectations or hides failures | AI output is a proposal: cannot edit matrices (`allowChangeApprovedMatrix` must be false), rejected when it changes approved probes, cites unknown ids or labels a security violation as flaky |
| T9 | Evidence tampering after a run | sha256 index; re-gate verifies every ref and blocks on mismatch; `run.json` never rewritten |
| T10 | Stale or superseded CI runs report success | Results bound to the PR head SHA; gate checks commit; workflow concurrency cancels old runs |
| T11 | Leftover test data or partial setup | Cleanup in `finally` with its own timeout, also on cancellation; failures recorded and block |
| T12 | Supply chain | Pinned versions, lockfile, `--ignore-scripts`, audit, SHA-pinned actions, Dependabot cooldown |
| T13 | Repeated side effects | Probes run once, never retried |

## Residual risks

- Redaction is best effort for secrets the kit does not know (e.g. a token the
  target generates in a response under a non-sensitive key). Keep bodies off and
  add sensitive keys to `evidence.redactFields`.
- The kit trusts reviewed config. Someone who can merge config changes can weaken
  the policy; protect those files with CODEOWNERS and required reviews.
- A zero false-PASS acceptance suite does not prove the absence of
  vulnerabilities in the system under test.
