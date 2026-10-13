# Operations

## Daily use

| Situation | Action |
| --- | --- |
| New PR | CI runs `qa-agent-kit run`; the summary shows GO/NO_GO and reasons |
| Tester finished manual E2E | Commit `manual-results.yaml`, then `qa-agent-kit gate --run <dir>` (no re-execution) |
| QA Lead accepted intake / cost-value | Update `qa-route.yaml`, then `gate` |
| Policy or requirement changed | Edit the source, `sources rehash`, review, set approval APPROVED |
| AMBER because of the environment | Fix it and re-run; BLOCKED never counts as passed |
| RED privilege escalation | Treat as a security finding: no waiver, fix and re-run |

## Investigating a failure

1. `report.md`: the blocking reason and the test key.
2. `evidence/permission/<matrix>/<probe>.json`: actor, operation, resolved input,
   sanitized request and response metadata, assertion outcomes, source revision.
3. `run.json`: lifecycle events (seed, actor, cleanup), plan and changed files.
4. `qa-agent-kit triage --run <dir>` for grouping and next steps.

## Cleanup failures

`CLEANUP_FAILED` means test data may be left behind. Remove it with the
fixture's cleanup operation (ids are in the evidence and lifecycle events),
then re-run. Fix the cause before relying on the gate again.

## Interrupting a run

The first Ctrl-C/SIGTERM cancels remaining probes (BLOCKED `CANCELLED`) and
still runs cleanup; the exit code is at least 2. A second signal exits
immediately (exit 4), possibly leaving fixtures.

## Retention

Artifacts hold sanitized but still sensitive metadata. Keep CI retention short
(7–14 days) and restrict who can download them.

## Rollback

The kit is a CLI pinned by version in the target repository. To roll back,
pin the previous version; run records include `kitVersion` and
`policyVersion` for reproduction.
