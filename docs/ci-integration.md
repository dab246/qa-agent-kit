# CI integration

The CI integration is a thin adapter: business rules live in TypeScript and the
workflow only calls the CLI.

## GitHub Actions

Copy [`examples/ci/github-pr-gate.yml`](../examples/ci/github-pr-gate.yml) into
the repository under test and make the `qa-gate` check required. It:

- runs on `pull_request` (opened, reopened, synchronize), never
  `pull_request_target`, with `contents: read` only;
- checks out the exact PR head SHA with full history (impact diff);
- cancels superseded runs (`concurrency`), so a stale run cannot report for a newer head;
- passes test credentials from an environment's secrets as environment variables;
- runs `qa-agent-kit run --ci github --summary` (job summary = compact report);
- uploads sanitized artifacts even when the gate fails.

`--ci github` reads `GITHUB_EVENT_PATH`: head/base SHA, PR number and title. On
pull requests from forks GitHub withholds secrets; the actors then fail to
resolve, probes are BLOCKED and the gate is NO_GO, which is the safe outcome.

## Other CI systems

Use `--ci local --commit <sha> --base <ref>` (or `--changed-files <file>`), and
publish `summary.md` and the run directory with the provider's own mechanisms.
New providers implement `CiAdapter` in `src/adapters/ci/ci.ts`.

## Lanes from other tools

Configure UI/E2E/NFR suites to emit JUnit XML (Playwright `--reporter=junit`,
Cypress `mocha-junit-reporter`, k6 `--out junit`), run them before the kit, and
list the files under `lanes.<name>.junit`. A missing report means zero results;
the policy's `minTests` turns that into NO_GO.

## Concurrency and fixtures

Fixture names should include `{{run.id}}` so parallel runs never share mutable
data. Run matrices serially (the driver does) until isolation is proven.
