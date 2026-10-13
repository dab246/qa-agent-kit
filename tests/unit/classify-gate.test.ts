import { describe, expect, it } from "vitest";
import { ExpectedOutcomeSchema, RouteRecordSchema } from "../../src/core/schemas.js";
import type { TestCase } from "../../src/lifecycle/test-pack.js";
import { classifyResponse, expectsDenial } from "../../src/permission/classify.js";
import { evaluateGate } from "../../src/release-gate/gate.js";
import { diagramLabel } from "../../src/reporting/markdown.js";
import { COMMIT, gateInput, policy, respond, result } from "../helpers.js";

const exp = (v: unknown) => ExpectedOutcomeSchema.parse(v);

describe("classifyResponse", () => {
  it.each([
    [{ kind: "http", status: 200 }, respond(200), "PASS", undefined],
    [{ kind: "http", status: [403, 404] }, respond(404), "PASS", undefined],
    [{ kind: "http", status: 403 }, respond(204), "FAIL", "PRIVILEGE_ESCALATION"],
    [{ kind: "http", status: 200 }, respond(401), "FAIL", "UNEXPECTED_DENIAL"],
    [{ kind: "http", status: 403 }, respond(404), "FAIL", "STATUS_MISMATCH"],
    [{ kind: "http", status: 200 }, respond(302), "FAIL", "STATUS_MISMATCH"],
    [{ kind: "error", code: "FORBIDDEN" }, respond(200, {}, { errorCode: "FORBIDDEN" }), "PASS", undefined],
    [{ kind: "error", code: "FORBIDDEN" }, respond(200, { data: {} }), "FAIL", "PRIVILEGE_ESCALATION"],
    [{ kind: "error", code: "FORBIDDEN" }, respond(200, {}, { errorCode: "UNAUTHENTICATED" }), "FAIL", "ERROR_CODE_MISMATCH"],
    [{ kind: "http", status: 200, assertions: [{ kind: "json-equals", path: "a", expected: 1 }] }, respond(200, { a: 2 }), "FAIL", "ASSERTION_FAILED"],
    [{ kind: "http", status: 403, assertions: [{ kind: "json-not-exists", path: "secret" }] }, respond(403, { secret: 1 }), "FAIL", "DATA_DISCLOSURE"],
    [{ kind: "http", status: 200, assertions: [{ kind: "json-exists", path: "a" }] }, respond(200, { a: 1 }, { bodyComplete: false }), "INCONCLUSIVE", "BODY_INCOMPLETE"],
  ])("%j vs %j → %s %s", (expected, response, status, category) => {
    const c = classifyResponse(exp(expected), response);
    expect(c.status).toBe(status);
    expect(c.category).toBe(category);
  });

  it("only all-4xx/5xx expectations count as denials", () => {
    expect(expectsDenial(exp({ kind: "http", status: [403, 404] }))).toBe(true);
    expect(expectsDenial(exp({ kind: "http", status: [200, 403] }))).toBe(false);
  });
});

describe("diagram labels", () => {
  it("map canonical results to V1/V2/V3/SKIP/ALLOW", () => {
    expect(diagramLabel(result({ expected: exp({ kind: "http", status: 403 }) }))).toBe("V1 pass");
    expect(diagramLabel(result({ expected: exp({ kind: "http", status: 200 }) }))).toBe("ALLOW");
    expect(diagramLabel(result({ status: "FAIL", category: "PRIVILEGE_ESCALATION" }))).toBe("V2 violation");
    expect(diagramLabel(result({ status: "INCONCLUSIVE", category: "UNRESOLVED_REFERENCE" }))).toBe("V3 inconclusive");
    expect(diagramLabel(result({ status: "INCONCLUSIVE", category: "NO_EXPECTATION" }))).toBe("SKIP");
  });
});

const route = (extra: Record<string, unknown> = {}) =>
  RouteRecordSchema.parse({
    schemaVersion: 1,
    routeId: "r",
    path: "A",
    owner: "lead",
    risk: "high",
    lanes: ["permission"],
    intake: { status: "ACCEPTED" },
    costValue: { decision: "GO" },
    ...extra,
  });

const tc = (extra: Partial<TestCase>): TestCase => ({
  id: "TC-1",
  title: "t",
  type: "manual-e2e",
  lane: "ui",
  priority: "P1",
  required: true,
  automation: [],
  file: "pack.md",
  line: 1,
  ...extra,
});

describe("release gate", () => {
  it("GO only when everything is satisfied", () => {
    expect(evaluateGate(gateInput([result()]))).toMatchObject({ decision: "GO", verdict: "GREEN", reasons: [] });
  });

  it.each(["BLOCKED", "INCONCLUSIVE", "SKIPPED"] as const)("required %s blocks as AMBER (needs review)", (status) => {
    const gate = evaluateGate(gateInput([result({ status })]));
    expect(gate).toMatchObject({ decision: "NO_GO", verdict: "AMBER" });
  });

  it("duplicate results for one test block (a stale PASS cannot mask a FAIL)", () => {
    const gate = evaluateGate(gateInput([result(), result({ status: "FAIL" })]));
    expect(gate.reasons.map((r) => r.code)).toContain("DUPLICATE_RESULT");
    expect(gate.decision).toBe("NO_GO");
  });

  it("unknown statuses block", () => {
    const gate = evaluateGate(gateInput([result({ status: "MAYBE" as never })]));
    expect(gate.reasons.map((r) => r.code)).toContain("UNKNOWN_STATUS");
  });

  it("results for another commit are stale", () => {
    const gate = evaluateGate(gateInput([result()], { resultsCommitSha: "fffffffffffffffffffffffffffffffffffffff0" }));
    expect(gate.reasons.map((r) => r.code)).toEqual(["STALE_RESULTS"]);
  });

  it("unapproved sources block", () => {
    const gate = evaluateGate(gateInput([result()], { sources: { approved: false, issues: ["changed"] } }));
    expect(gate.reasons).toEqual([expect.objectContaining({ code: "SOURCES_NOT_APPROVED", message: "changed" })]);
  });

  it("NOT_APPLICABLE needs a recorded reason", () => {
    const gate = evaluateGate(gateInput([result({ status: "NOT_APPLICABLE" })]));
    expect(gate.reasons.map((r) => r.code)).toContain("NOT_APPLICABLE_WITHOUT_REASON");
  });

  it("exceptions waive a non-critical failure only for their commit and until they expire", () => {
    const fail = [result({ status: "FAIL", category: "STATUS_MISMATCH" })];
    const ex = { testKey: "permission:m1:t1", reason: "tracked in ISSUE-1", approvedBy: "lead", commitSha: COMMIT.slice(0, 7), expiresAt: "2099-01-01" };
    expect(evaluateGate(gateInput(fail, { policy: policy({ exceptions: [ex] }) })).decision).toBe("GO");
    expect(evaluateGate(gateInput(fail, { policy: policy({ exceptions: [{ ...ex, expiresAt: "2020-01-01" }] }) })).decision).toBe("NO_GO");
    expect(evaluateGate(gateInput(fail, { policy: policy({ exceptions: [{ ...ex, commitSha: "deadbee" }] }) })).decision).toBe("NO_GO");
  });

  it("required lanes need a minimum number of results; missing lane reports are surfaced", () => {
    const gate = evaluateGate(
      gateInput([result()], { policy: policy({ lanes: { ui: { required: true, minTests: 1 } } }), missingLaneReports: ["ui.xml"] }),
    );
    expect(gate.reasons.map((r) => r.code)).toEqual(["LANE_MISSING_RESULTS", "LANE_REPORT_MISSING"]);
    expect(gate.verdict).toBe("AMBER");
  });

  describe("diagram 1 main gate (lifecycle)", () => {
    const strict = policy({ lifecycle: {} });

    it("needs a route with accepted intake and a GO cost/value decision", () => {
      expect(evaluateGate(gateInput([result()], { policy: strict })).reasons.map((r) => r.code)).toContain("ROUTE_MISSING");
      const pending = evaluateGate(
        gateInput([result()], { policy: strict, route: route({ intake: { status: "PENDING" }, costValue: { decision: "PENDING" } }) }),
      );
      expect(pending.reasons.map((r) => r.code)).toEqual(["INTAKE_NOT_ACCEPTED", "COST_VALUE_NOT_GO"]);
    });

    it("needs every required manual E2E case to PASS (latest result wins)", () => {
      const cases = [tc({ id: "TC-1" }), tc({ id: "TC-2" }), tc({ id: "TC-3", required: false })];
      const results = [
        { tcId: "TC-1", status: "FAIL" as const, tester: "a", executedAt: "2026-10-01T00:00:00Z", evidence: [] },
        { tcId: "TC-1", status: "PASS" as const, tester: "a", executedAt: "2026-10-02T00:00:00Z", evidence: [] },
      ];
      const gate = evaluateGate(gateInput([result()], { policy: strict, route: route(), manual: { cases, results } }));
      expect(gate.reasons.map((r) => [r.code, r.message.slice(0, 4)])).toEqual([["MANUAL_E2E_NOT_RUN", "TC-2"]]);
      const failed = evaluateGate(
        gateInput([result()], {
          policy: strict,
          route: route(),
          manual: { cases: [tc({})], results: [{ ...results[0]! }] },
        }),
      );
      expect(failed.verdict).toBe("RED");
    });

    it("automated test cases must link to results that passed (traceability)", () => {
      const cases = [tc({ id: "TC-A", type: "automated", automation: ["permission:m1:t1", "permission:m1:gone"] }), tc({ id: "TC-B", type: "automated" })];
      const gate = evaluateGate(gateInput([result({ status: "FAIL" })], { manual: { cases, results: [] } }));
      expect(gate.reasons.map((r) => r.code)).toEqual(
        expect.arrayContaining(["LINKED_TEST_FAILED", "TRACEABILITY_GAP"]),
      );
      expect(gate.reasons.filter((r) => r.code === "TRACEABILITY_GAP")).toHaveLength(2);
    });
  });
});
