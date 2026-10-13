# Release policy

The gate is a pure function of results, plan, sources, route, manual results,
lifecycle events and `release-policy.yaml`. No AI output is an input.

## Verdicts

| Verdict | Decision | Exit | Meaning |
| --- | --- | --- | --- |
| GREEN | GO | 0 | Every mandatory condition holds |
| RED | NO_GO | 1 | Definite failure: critical violation, required FAIL, failed manual E2E, failed linked test |
| AMBER | NO_GO | 2 | Needs review: missing/blocked/inconclusive/skipped result, missing evidence, unapproved sources, cleanup failure, stale results, lifecycle decision pending |

## Rules

- Required tests = required probes of the selected matrices + `requiredTests`
  + any result marked `required` (JUnit lanes use the lane's `required`).
- `blockOnStatuses` (default FAIL, BLOCKED, INCONCLUSIVE, SKIPPED) block
  required tests. A required test without a result blocks.
- `criticalAlwaysBlocks`: `PRIVILEGE_ESCALATION` and `DATA_DISCLOSURE` block
  even on optional probes, and cannot be waived.
- `optionalFailures`: `warn` (default) or `block`.
- `requireEvidence`, `requireSourceApproval`, `requireCleanupSuccess`,
  `requireResultsForCommit` (results must be for the commit being gated).
- `lifecycle`: intake ACCEPTED, cost/value GO, required manual E2E PASS
  (diagram 1 main gate).
- `lanes.<name>`: `required` and `minTests`, so a lane cannot pass by producing
  nothing.
- Duplicate results for one test and unknown statuses block.

## Exceptions

```yaml
exceptions:
  - testKey: permission:settings-permissions:some-probe
    reason: Tracked in ISSUE-123, fix in next release
    approvedBy: release-owner
    commitSha: 0123abc          # valid for this commit only
    expiresAt: "2026-11-01T00:00:00Z"
```

An exception waives one non-critical blocking result for one commit until it
expires. Expired or other-commit exceptions are reported and ignored. Changes to
the policy file go through code review; the report lists every waiver.
