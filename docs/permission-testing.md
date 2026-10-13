# Permission testing

## Matrix

A matrix (`schemas/permission-matrix.schema.json`) lists actors and probes. Each
probe is *actor × operation × input → approved expectation*:

```yaml
- id: regular-user-update-admin-settings
  actorRef: regular-user
  operationId: settings.admin.update     # must exist in target.yaml (allowlist)
  input: { theme: dark }
  expected:
    kind: http                           # or kind: error, code: FORBIDDEN (GraphQL)
    status: 403                          # or a list: [403, 404]
    assertions:
      - kind: json-not-exists            # a denial must not return the data
        path: settings
  severity: critical                     # critical | high | normal
  required: true                         # default
  fixtureRefs: [user-project]            # seeded once per matrix, cleaned up after
  timeoutMs: 10000
```

Inputs, resource refs and assertion values may use `{{run.id}}` and
`{{fixture.<id>.<path>}}` (values captured by the fixture's seed). There is no
expression language: matrices are data.

## Driver sequence (diagram 2, box 6)

1. Validate the matrix against the target: operations allowlisted, actors
   provisioned **with the same role**, fixtures known, ids unique. Any issue
   stops the whole run before anything executes.
2. Seed fixtures once (diagram box 1). A failed seed blocks only the probes that
   use it, and is still cleaned up.
3. Resolve each actor once (box 5: fresh login, optional OTP). A provider that
   returns another identity is rejected (`ACTOR_MISMATCH`).
4. Run each probe once (no retries), with its own timeout and the run's
   cancellation signal, then classify it and write evidence.
5. Dispose sessions and clean up fixtures in reverse order, always.

## Classification

| Situation | Status | Category | Diagram |
| --- | --- | --- | --- |
| Expected denial, denied, assertions hold | PASS | — | V1 |
| Expected allow, allowed, assertions hold | PASS | — | ALLOW |
| Expected denial, got 2xx | FAIL | `PRIVILEGE_ESCALATION` (critical) | V2 |
| Denial body contains protected data | FAIL | `DATA_DISCLOSURE` (critical) | — |
| Expected allow, got 4xx/5xx | FAIL | `UNEXPECTED_DENIAL` | — |
| Other status / error code / assertion | FAIL | `STATUS_MISMATCH`, `ERROR_CODE_MISMATCH`, `ASSERTION_FAILED` | — |
| No expectation | INCONCLUSIVE | `NO_EXPECTATION` | SKIP |
| Unresolved fixture/master-data reference | INCONCLUSIVE | `UNRESOLVED_REFERENCE` | V3 |
| Body truncated, assertions unprovable | INCONCLUSIVE | `BODY_INCOMPLETE` | — |
| Seed, actor, timeout, transport error, cancel | BLOCKED | `SEED_FAILED`, `ACTOR_*`, `TIMEOUT`, `EXECUTION_ERROR`, `CANCELLED` | — |
| After a critical violation with `stopOnCriticalViolation` | SKIPPED | `STOPPED_AFTER_CRITICAL` | — |

A 200 is a violation only relative to an expected denial, and a 403 is only safe
if its body does not carry what the assertions protect.

## Target (`target.yaml`)

The generic HTTP adapter covers REST and GraphQL:

- `operations`: method, path with `{param}` (URL-encoded), `query` keys, optional
  `graphql` query, `errorCodePath`.
- `actors`: `role` and `auth` (`none`, `bearer-env`, or `login` with
  `usernameEnv`/`passwordEnv`/`otpEnv` and `tokenPath`). Only environment
  variable **names** are allowed.
- `fixtures`: a `seed` step (with `capture`) and an optional `cleanup` step.

Redirects are not followed, bodies are read up to 1 MiB, query values never
appear in evidence. Another protocol or SDK can implement `Target`
(`src/core/interfaces.ts`) directly.
