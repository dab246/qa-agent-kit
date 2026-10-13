import { describe, expect, it } from "vitest";
import { renderProposalReview, reviewProposal, TestProposalSchema } from "../../src/ai/proposal.js";
import { buildTriageContext, deterministicTriage, renderTriage, triageIssues } from "../../src/ai/triage.js";
import { SourceManifestSchema } from "../../src/core/schemas.js";
import type { RunRecord } from "../../src/reporting/run-record.js";
import { allow, deny, matrix, result } from "../helpers.js";

const manifest = SourceManifestSchema.parse({
  schemaVersion: 1,
  manifestId: "m",
  sources: [
    { id: "policy", type: "policy", revision: "r1", status: "VERIFIED" },
    { id: "draft", type: "requirement", revision: "r1", status: "ASSUMPTION" },
  ],
  approval: { status: "APPROVED" },
});
const catalog = {
  operations: { has: (id: string) => id === "op.read" || id === "op.write" },
  fixtures: { has: (id: string) => id === "f" },
  roleOf: () => "regular-user",
};
const approved = matrix([
  { id: "read", expected: allow },
  { id: "write", operationId: "op.write", expected: deny, input: { a: 1 } },
]);
const proposal = (probes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  TestProposalSchema.parse({
    schemaVersion: 1,
    proposalId: "p1",
    matrixId: "m1",
    generatedBy: { model: "m", promptVersion: "qa-planner/1" },
    sourceRefs: [{ id: "policy", revision: "r1" }],
    probes: probes.map((p) => ({ actorRef: "user", operationId: "op.read", rationale: "policy rule 1", ...p })),
    ...extra,
  });

describe("proposal review", () => {
  it("classifies every verdict and drafts only NEW and NEEDS_REVIEW probes", () => {
    const p = proposal([
      { suggestedId: "admin-write-denied", actorRef: "admin", operationId: "op.write", expected: deny, fixtureRefs: ["f"] },
      { suggestedId: "open-question", operationId: "op.write", input: { a: 2 }, unresolvedQuestions: ["is it allowed?"], expected: deny },
      { suggestedId: "no-expectation", operationId: "op.write", input: { a: 3 } },
      { suggestedId: "read", expected: allow },
      { suggestedId: "write-again", operationId: "op.write", input: { a: 1 }, expected: deny },
      { suggestedId: "ghost-actor", actorRef: "ghost", expected: allow },
      { suggestedId: "bad-op", operationId: "op.delete", expected: deny },
      { suggestedId: "bad-fixture", expected: allow, fixtureRefs: ["nope"], input: { z: 1 } },
      { suggestedId: "admin-write-denied", actorRef: "admin", operationId: "op.write", expected: deny, input: { b: 1 } },
    ]);
    const review = reviewProposal(p, approved, catalog, manifest);
    expect(review.issues).toEqual([]);
    expect(review.items.map((i) => [i.suggestedId, i.verdict])).toEqual([
      ["admin-write-denied", "NEW"],
      ["open-question", "NEEDS_REVIEW"],
      ["no-expectation", "NEEDS_REVIEW"],
      ["read", "DUPLICATE"],
      ["write-again", "DUPLICATE"],
      ["ghost-actor", "REJECTED"],
      ["bad-op", "REJECTED"],
      ["bad-fixture", "REJECTED"],
      ["admin-write-denied", "REJECTED"],
    ]);
    expect(review.items[2]?.reasons).toEqual(["no expected outcome: a human must decide it from an approved source"]);
    expect(review.items[4]?.reasons).toEqual(["covered by approved probe 'write'"]);
    expect(review.draft.map((d) => [d.id, d.expected?.kind ?? "none"])).toEqual([
      ["admin-write-denied", "http"],
      ["open-question", "none"],
      ["no-expectation", "none"],
    ]);
  });

  it("rejects everything when the matrix is unknown or a source is not verified", () => {
    const review = reviewProposal(
      proposal([{ suggestedId: "x", expected: allow }], { sourceRefs: [{ id: "draft", revision: "r1" }, { id: "gone", revision: "1" }] }),
      undefined,
      catalog,
      manifest,
    );
    expect(review.issues).toEqual([
      "matrix 'm1' does not exist; new matrices are created by humans",
      "source 'draft' is ASSUMPTION, not VERIFIED",
      "source 'gone' is not in the source manifest",
    ]);
    expect(review.items[0]?.verdict).toBe("REJECTED");
    expect(review.draft).toEqual([]);
  });

  it("renders untrusted rationale inertly and neutralises code fences in drafts", () => {
    const p = proposal([{ suggestedId: "n", expected: allow, rationale: "<script>x</script> [link](http://e)", input: { q: "```\n# h" } }]);
    const text = renderProposalReview(reviewProposal(p, approved, catalog, manifest), p);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("](http://e)");
    expect(text.match(/```/g)).toHaveLength(2);
  });
});

describe("triage", () => {
  const record = {
    runId: "r",
    commitSha: "c",
    results: [
      result({ testId: "ok" }),
      result({ testId: "esc", status: "FAIL", category: "PRIVILEGE_ESCALATION", failureReason: "x".repeat(400) }),
      result({ testId: "slow", status: "BLOCKED", category: "TIMEOUT" }),
      result({ testId: "na", status: "NOT_APPLICABLE", failureReason: "n/a" }),
      result({ testId: "odd", status: "FAIL" }),
    ],
    lifecycle: [{ matrixId: "m1", phase: "cleanup", ref: "f", ok: false, error: "boom" }],
  } as unknown as RunRecord;

  it("groups non-passing results deterministically", () => {
    const report = deterministicTriage(record);
    expect(report.findings.map((f) => [f.category, f.confidence, f.supportingTestKeys])).toEqual([
      ["possible-authorization-regression", "high", ["permission:m1:esc"]],
      ["environment-or-setup", "medium", ["permission:m1:slow"]],
      ["expectation-mismatch", "medium", ["permission:m1:odd"]],
    ]);
    expect(renderTriage(report)).toContain("does not change any result");
  });

  it("gives a model only sanitized, minimal context", () => {
    const context = buildTriageContext(record) as { results: Array<{ testKey: string; failureReason?: string }> };
    expect(context.results.map((r) => r.testKey)).not.toContain("permission:m1:ok");
    expect(context.results[0]?.failureReason).toHaveLength(300);
  });

  it("rejects AI triage that cites unknown, passing or foreign data", () => {
    const issues = triageIssues(
      {
        schemaVersion: 1,
        runId: "other",
        generatedBy: { model: "m", promptVersion: "1" },
        findings: [
          { findingId: "f", category: "lane-test-failure", confidence: "low", summary: "s", supportingTestKeys: ["permission:m1:ok", "x:y:z"], evidenceRefs: ["nope"], recommendedNextSteps: [] },
          { findingId: "f", category: "lane-test-failure", confidence: "low", summary: "s", supportingTestKeys: ["permission:m1:odd"], evidenceRefs: [], recommendedNextSteps: [] },
        ],
      },
      record,
    );
    expect(issues).toEqual([
      "triage is for run 'other', not 'r'",
      "f: cites 'permission:m1:ok', which passed",
      "f: cites unknown test 'x:y:z'",
      "f: cites unknown evidence 'nope'",
      "finding id 'f' is duplicated",
    ]);
  });
});
