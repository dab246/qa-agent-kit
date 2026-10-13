# AI assistance (advisory)

The deterministic pipeline works with AI disabled. AI can help in two places,
and in both its output is untrusted input to a deterministic check.

## Planning: test proposals

1. Give a model `prompts/qa-planner.md`, the change summary, the approved
   sources, the current matrix and the operation list.
2. Save its JSON output (`schemas/test-proposal.schema.json`).
3. `qa-agent-kit proposal review --proposal p.json` writes
   `proposals/pending/<id>.md` and `.review.json`. Each probe is `NEW`,
   `NEEDS_REVIEW` (no expectation or open questions; its draft has no
   `expected`, so it could never PASS), `DUPLICATE` or `REJECTED` (unknown
   operation/actor/fixture, unapproved source, or any attempt to change an
   approved probe, including under a new id).
4. A human copies accepted probes into the matrix through a normal code review.
   The kit never writes a matrix.

## Triage

1. `qa-agent-kit triage --run <dir>` writes a deterministic `triage.md` and a
   sanitized `triage-context.json` (non-passing results only, no bodies, inputs
   or headers, free text truncated and marked untrusted).
2. Give a model `prompts/failure-triage.md` and the context.
3. `qa-agent-kit triage --run <dir> --import ai.json` validates it: it must cite
   only existing non-passing tests and evidence, and may not label a privilege
   escalation or data disclosure as flakiness. The result is `triage-ai.md`.

Triage never changes a result, a waiver or the gate. Record the model id and
prompt version (`generatedBy`) in every AI output.
