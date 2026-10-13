# Integrating the kit into a project

The kit never runs inside the application. It sits next to the project's own
tests, in CI, and turns their results plus the human decisions of the QA
lifecycle into one GO / NO_GO check on every pull request.

## Which parts apply

| The project has… | Use | Example |
| --- | --- | --- |
| An HTTP/GraphQL API with logins and roles | **Permission lane** (`target.yaml` + matrices) and everything below | `examples/minimal-permission-suite` |
| Automated tests in any tool that writes JUnit XML (Vitest, Jest, Playwright, Cypress, k6, pytest, JUnit, Flutter `--machine` via a converter…) | **Lane intake** (`lanes.<name>.junit`) | [ChronoWork](https://github.com/dab246/ChronoWork) `qa/` |
| Requirements, ADRs, policies | **Phase 0 sources** (`source-manifest.yaml`, sha256-pinned) | both |
| Manual or exploratory checks | **Markdown test pack** + `manual-results.yaml` | both |
| A release / merge decision | **Release gate** (`release-policy.yaml`) | both |

A browser-only app (no server, no accounts) has nothing for the permission lane
to probe; it still gets source traceability, the test pack as source of truth,
lane intake, manual E2E sign-off and the gate.

## Steps

1. **Scaffold** a `qa/` folder: `npx qa-agent-kit init qa`, then delete what
   does not apply (e.g. `target.yaml`, `matrices/`, the `permission:` section).
2. **Phase 0:** list the documents the tests are checked against in
   `source-manifest.yaml`. Pin files with `sha256` (`shasum -a 256 <file>`) so
   an edit re-opens review. A reviewer sets `approval.status: APPROVED`.
3. **Phase 1:** write the test pack in Markdown. One `## TC-…` per case,
   `Type: automated` with `Automation:` links to test keys, or
   `Type: manual-e2e` for what a person checks.
4. **Lanes:** make each test tool write JUnit XML to a known path and list it
   under `lanes`. Set `release-policy.yaml` `lanes.<name>.minTests` so a lane
   that silently ran nothing blocks.
5. **Route (S0):** the QA Lead fills `qa-route.yaml` (path, owner, risk, gaps,
   intake and cost/value decisions).
6. **CI:** after the tests ran, run
   `qa-agent-kit run --config qa/qa-agent-kit.yaml --ci github --summary` and
   upload the run directory. Start **advisory** (not a required check); once
   the sign-offs are in place, make it a required status check.
7. **Each release:** testers record `manual-results.yaml`; `qa-agent-kit gate
   --run <dir>` re-evaluates without re-running anything.

## Getting the kit in CI

Until the kit is published to a registry, check it out at a pinned commit and
build it (no install scripts, exact lockfile):

```yaml
- uses: actions/checkout@<sha> # v7
  with:
    repository: dab246/qa-agent-kit
    ref: <full commit sha>        # pin; update deliberately
    path: .qa-agent-kit
    persist-credentials: false
- run: npm ci --ignore-scripts && npm run build
  working-directory: .qa-agent-kit
- run: node .qa-agent-kit/dist/cli/main.js run --config qa/qa-agent-kit.yaml --ci github --summary
```
