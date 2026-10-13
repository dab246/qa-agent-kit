import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { PermissionMatrixSchema } from "../../src/core/schemas.js";
import { runMatrix } from "../../src/permission/driver.js";
import { evaluateGate } from "../../src/release-gate/gate.js";
import {
  allow,
  deny,
  driverOptions,
  fakeTarget,
  gateInput,
  matrix,
  MemoryEvidence,
  policy,
  respond,
  result,
  runContext,
} from "../helpers.js";

// Plan §16.1, against the in-memory fake adapter.
describe("permission engine acceptance (AT-01…AT-15)", () => {
  it("AT-01: expected 200, actual 200 → PASS", async () => {
    const target = fakeTarget({ "op.read": () => respond(200, { ok: true }) });
    const run = await runMatrix(matrix([{ id: "p", expected: allow }]), runContext(), driverOptions(target));
    expect(run.results[0]).toMatchObject({ status: "PASS", actual: { httpStatus: 200 } });
  });

  it("AT-02: expected 403, actual 403 → PASS", async () => {
    const target = fakeTarget({ "op.read": () => respond(403) });
    const run = await runMatrix(matrix([{ id: "p", expected: deny }]), runContext(), driverOptions(target));
    expect(run.results[0]?.status).toBe("PASS");
  });

  it("AT-03: expected 403, actual 200 → FAIL privilege escalation and NO_GO", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const run = await runMatrix(matrix([{ id: "p", expected: deny, severity: "normal" }]), runContext(), driverOptions(target));
    const r = run.results[0]!;
    expect(r).toMatchObject({ status: "FAIL", category: "PRIVILEGE_ESCALATION", severity: "critical" });
    const gate = evaluateGate(gateInput(run.results));
    expect(gate).toMatchObject({ decision: "NO_GO", verdict: "RED" });
    expect(gate.reasons.map((x) => x.code)).toContain("CRITICAL_VIOLATION");
  });

  it("AT-04: expected 200, actual 403 → FAIL with diagnostic evidence retained", async () => {
    const evidence = new MemoryEvidence();
    const target = fakeTarget({ "op.read": () => respond(403, { error: "forbidden" }) });
    const run = await runMatrix(matrix([{ id: "p", expected: allow }]), runContext(), driverOptions(target, evidence));
    expect(run.results[0]).toMatchObject({ status: "FAIL", category: "UNEXPECTED_DENIAL", evidenceRefs: ["evidence/p.json"] });
    expect(evidence.written[0]?.details).toMatchObject({ response: { status: 403 } });
  });

  it("AT-05: missing expectation → INCONCLUSIVE, never PASS, never executed", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const run = await runMatrix(matrix([{ id: "p" }]), runContext(), driverOptions(target));
    expect(run.results[0]).toMatchObject({ status: "INCONCLUSIVE", category: "NO_EXPECTATION" });
    expect(target.calls).toHaveLength(0);
    expect(evaluateGate(gateInput(run.results)).decision).toBe("NO_GO");
  });

  it("AT-06: unknown operation id → matrix rejected before any execution", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const m = matrix([
      { id: "ok", expected: allow },
      { id: "bad", operationId: "op.unknown", expected: allow },
    ]);
    await expect(runMatrix(m, runContext(), driverOptions(target))).rejects.toThrow(ValidationError);
    expect(target.calls).toHaveLength(0);
    expect(target.seeded).toHaveLength(0);
  });

  it("AT-07: invalid actor reference or role drift → rejected, no privilege substitution", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    await expect(runMatrix(matrix([{ id: "p", actorRef: "ghost", expected: allow }]), runContext(), driverOptions(target))).rejects.toThrow(
      /unknown actorRef 'ghost'/,
    );
    // The target provisions 'user' as regular-user; a matrix claiming it is an admin must not run.
    const drift = matrix([{ id: "p", expected: allow }], { actors: [{ ref: "user", role: "administrator" }] });
    await expect(runMatrix(drift, runContext(), driverOptions(target))).rejects.toThrow(/has role 'regular-user'/);
    expect(target.calls).toHaveLength(0);
  });

  it("AT-08: timeout → BLOCKED with timeout evidence, even when the adapter ignores the signal", async () => {
    const evidence = new MemoryEvidence();
    const target = fakeTarget({ "op.read": () => new Promise(() => undefined) });
    const run = await runMatrix(
      matrix([{ id: "p", expected: allow, timeoutMs: 100 }]),
      runContext(),
      driverOptions(target, evidence),
    );
    expect(run.results[0]).toMatchObject({ status: "BLOCKED", category: "TIMEOUT" });
    expect(evidence.written[0]?.result.category).toBe("TIMEOUT");
  });

  it("AT-09: optional probe failure follows the explicit policy", async () => {
    const optional = [result({ testId: "opt", required: false, status: "FAIL", category: "STATUS_MISMATCH" })];
    const warn = evaluateGate(gateInput(optional, { policy: policy({ optionalFailures: "warn" }) }));
    expect(warn).toMatchObject({ decision: "GO", verdict: "GREEN" });
    expect(warn.reasons.map((r) => r.code)).toEqual(["OPTIONAL_FAILED"]);
    const block = evaluateGate(gateInput(optional, { policy: policy({ optionalFailures: "block" }) }));
    expect(block).toMatchObject({ decision: "NO_GO", verdict: "RED" });
  });

  it("AT-10: required probe without a result → NO_GO", () => {
    const gate = evaluateGate(gateInput([result()], { plannedRequired: ["permission:m1:t1", "permission:m1:t2"] }));
    expect(gate.decision).toBe("NO_GO");
    expect(gate.reasons).toContainEqual(expect.objectContaining({ code: "MISSING_RESULT", testKey: "permission:m1:t2" }));
  });

  it("AT-11: required evidence missing → NO_GO", () => {
    const gate = evaluateGate(gateInput([result({ evidenceRefs: [] })]));
    expect(gate.decision).toBe("NO_GO");
    expect(gate.reasons.map((r) => r.code)).toContain("MISSING_EVIDENCE");
  });

  it("AT-12: invalid schema → rejected, so nothing can execute", () => {
    const parsed = PermissionMatrixSchema.safeParse({
      schemaVersion: 1,
      matrixId: "m1",
      version: 1,
      sourceRefs: [{ id: "p", revision: "r" }],
      actors: [{ ref: "user", role: "regular-user" }],
      probes: [{ id: "p", actorRef: "user", operationId: "op.read", expected: { kind: "http", status: "403" }, script: "rm -rf /" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("AT-13: duplicate probe ids → matrix rejected", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const m = matrix([
      { id: "p", expected: allow },
      { id: "p", expected: deny },
    ]);
    await expect(runMatrix(m, runContext(), driverOptions(target))).rejects.toThrow(/probe id 'p' is duplicated/);
  });

  it("AT-14: cleanup failure keeps the probe result and is recorded separately", async () => {
    const target = fakeTarget(
      { "op.read": () => respond(200) },
      { fixtures: { f: { seed: () => ({ id: 1 }), cleanup: () => Promise.reject(new Error("db locked")) } } },
    );
    const run = await runMatrix(matrix([{ id: "p", expected: allow, fixtureRefs: ["f"] }]), runContext(), driverOptions(target));
    expect(run.results[0]?.status).toBe("PASS");
    expect(run.lifecycle).toContainEqual(expect.objectContaining({ phase: "cleanup", ref: "f", ok: false, error: "db locked" }));
    const gate = evaluateGate(gateInput(run.results, { lifecycleFailures: run.lifecycle.filter((e) => !e.ok) }));
    expect(gate.reasons.map((r) => r.code)).toContain("CLEANUP_FAILED");
    expect(gate.decision).toBe("NO_GO");
  });

  it("AT-15: evidence writer failure → no false PASS at the gate", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const run = await runMatrix(
      matrix([{ id: "p", expected: allow }]),
      runContext(),
      driverOptions(target, new MemoryEvidence("disk full")),
    );
    // The observed outcome is kept as is; the missing evidence is what blocks.
    expect(run.results[0]).toMatchObject({ status: "PASS", evidenceError: "disk full", evidenceRefs: [] });
    const gate = evaluateGate(gateInput(run.results));
    expect(gate.decision).toBe("NO_GO");
    expect(gate.reasons).toContainEqual(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
  });
});

describe("runner invariants", () => {
  it("never retries: a side-effecting operation runs exactly once per probe", async () => {
    const target = fakeTarget({ "op.read": () => Promise.reject(new Error("connection reset")) });
    const run = await runMatrix(matrix([{ id: "p", expected: allow }]), runContext(), driverOptions(target));
    expect(run.results[0]).toMatchObject({ status: "BLOCKED", category: "EXECUTION_ERROR" });
    expect(target.calls).toHaveLength(1);
  });

  it("a failing probe does not erase earlier results", async () => {
    let n = 0;
    const target = fakeTarget({ "op.read": () => (n++ === 0 ? respond(200) : Promise.reject(new Error("boom"))) });
    const run = await runMatrix(
      matrix([
        { id: "a", expected: allow },
        { id: "b", expected: allow },
      ]),
      runContext(),
      driverOptions(target),
    );
    expect(run.results.map((r) => [r.testId, r.status])).toEqual([
      ["a", "PASS"],
      ["b", "BLOCKED"],
    ]);
  });

  it("seed failure blocks dependent probes only, and the partial seed is still cleaned up", async () => {
    const target = fakeTarget(
      { "op.read": () => respond(200) },
      { fixtures: { f: { seed: () => Promise.reject(new Error("seed broke")) } } },
    );
    const run = await runMatrix(
      matrix([
        { id: "needs-f", expected: allow, fixtureRefs: ["f"] },
        { id: "free", expected: allow },
      ]),
      runContext(),
      driverOptions(target),
    );
    expect(run.results.map((r) => r.status)).toEqual(["BLOCKED", "PASS"]);
    expect(run.results[0]?.category).toBe("SEED_FAILED");
    expect(target.cleaned).toEqual(["f"]);
  });

  it("unresolved fixture reference → INCONCLUSIVE (V3), operation not called", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) }, { fixtures: { f: { seed: () => ({}) } } });
    const run = await runMatrix(
      matrix([{ id: "p", expected: allow, fixtureRefs: ["f"], input: { id: "{{fixture.f.id}}" } }]),
      runContext(),
      driverOptions(target),
    );
    expect(run.results[0]).toMatchObject({ status: "INCONCLUSIVE", category: "UNRESOLVED_REFERENCE" });
    expect(target.calls).toHaveLength(0);
  });

  it("fixture values flow into inputs (typed) and expectations", async () => {
    const target = fakeTarget(
      { "op.read": ({ request }) => respond(200, { id: request.input["id"] }) },
      { fixtures: { f: { seed: () => ({ id: 42 }) } } },
    );
    const run = await runMatrix(
      matrix([
        {
          id: "p",
          fixtureRefs: ["f"],
          input: { id: "{{fixture.f.id}}" },
          expected: { kind: "http", status: 200, assertions: [{ kind: "json-equals", path: "id", expected: "{{fixture.f.id}}" }] },
        },
      ]),
      runContext(),
      driverOptions(target),
    );
    expect(target.calls[0]?.input).toEqual({ id: 42 });
    expect(run.results[0]?.status).toBe("PASS");
  });

  it("cancellation marks remaining probes BLOCKED and still runs cleanup", async () => {
    const controller = new AbortController();
    const target = fakeTarget(
      {
        "op.read": () => {
          controller.abort(new Error("stop"));
          return new Promise(() => undefined);
        },
      },
      { fixtures: { f: { seed: () => ({ id: 1 }) } } },
    );
    const run = await runMatrix(
      matrix([
        { id: "a", expected: allow, fixtureRefs: ["f"] },
        { id: "b", expected: allow },
      ]),
      runContext(controller.signal),
      driverOptions(target),
    );
    expect(run.results.map((r) => r.category)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(target.cleaned).toEqual(["f"]);
    expect(target.disposed).toEqual(["user"]);
  });

  it("stopOnCriticalViolation skips the rest after a privilege escalation", async () => {
    const target = fakeTarget({ "op.read": () => respond(200) });
    const run = await runMatrix(
      matrix([
        { id: "esc", expected: deny },
        { id: "next", expected: allow },
      ]),
      runContext(),
      driverOptions(target, undefined, { stopOnCriticalViolation: true }),
    );
    expect(run.results.map((r) => [r.status, r.category])).toEqual([
      ["FAIL", "PRIVILEGE_ESCALATION"],
      ["SKIPPED", "STOPPED_AFTER_CRITICAL"],
    ]);
  });

  it("every probe records traceability fields", async () => {
    const target = fakeTarget({ "op.read": () => respond(403) });
    const run = await runMatrix(matrix([{ id: "p", expected: deny }]), runContext(), driverOptions(target));
    expect(run.results[0]).toMatchObject({
      runId: "run-1",
      lane: "permission",
      suiteId: "m1",
      suiteVersion: 1,
      testId: "p",
      actorRef: "user",
      role: "regular-user",
      operationId: "op.read",
      expected: { kind: "http", status: 403 },
    });
  });
});
