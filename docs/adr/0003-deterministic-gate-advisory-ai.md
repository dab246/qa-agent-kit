# ADR 0003: Deterministic gate, advisory AI

Status: accepted

## Decision

PASS/FAIL comes from comparing observed responses with approved expectations;
GO/NO_GO from a pure policy function. AI output (proposals, triage) is
validated by deterministic checks and can only produce review material. The
config schema makes `ai.allowChangeApprovedMatrix` impossible to enable. No
model provider is built in: prompts are versioned files and outputs are
imported as JSON.

## Consequences

The kit works with AI disabled. Model choice can change without touching the
gate. Prompt injection can at worst produce a rejected or advisory document.
