import { stringify } from "yaml";
import { z } from "zod";
import { deepEqual } from "../core/json-path.js";
import { omitUndefined } from "../core/objects.js";
import {
  ExpectedOutcomeSchema,
  FixtureIdSchema,
  IdSchema,
  SchemaVersionSchema,
  SeveritySchema,
  SourceRefSchema,
  type PermissionMatrix,
  type PermissionProbe,
  type SourceManifest,
} from "../core/schemas.js";
import type { MatrixCatalog } from "../permission/matrix.js";
import { md } from "../reporting/escape.js";

/** Provenance of an AI output: which model and prompt version shaped it. */
export const GeneratedBySchema = z.strictObject({
  model: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(100),
});

/**
 * What a planning agent may hand in. A proposal is never runnable: it is
 * reviewed here and only a human can copy accepted probes into a matrix.
 */
export const TestProposalSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  proposalId: IdSchema,
  matrixId: IdSchema,
  generatedBy: GeneratedBySchema,
  sourceRefs: z.array(SourceRefSchema).min(1),
  probes: z
    .array(
      z.strictObject({
        suggestedId: IdSchema,
        actorRef: IdSchema,
        operationId: IdSchema,
        input: z.record(z.string(), z.unknown()).default({}),
        resourceRef: z.string().max(500).optional(),
        fixtureRefs: z.array(FixtureIdSchema).default([]),
        expected: ExpectedOutcomeSchema.optional(),
        required: z.boolean().default(true),
        severity: SeveritySchema.default("high"),
        rationale: z.string().min(1).max(2000),
        unresolvedQuestions: z.array(z.string().max(500)).max(20).default([]),
      }),
    )
    .min(1)
    .max(200),
});
export type TestProposal = z.infer<typeof TestProposalSchema>;

export type ProposalVerdict = "NEW" | "NEEDS_REVIEW" | "DUPLICATE" | "REJECTED";

export interface ProposalItemReview {
  suggestedId: string;
  verdict: ProposalVerdict;
  reasons: string[];
}

export interface ProposalReview {
  proposalId: string;
  matrixId: string;
  generatedBy: TestProposal["generatedBy"];
  /** Proposal-level problems (unknown matrix, unapproved sources): every item is then rejected. */
  issues: string[];
  items: ProposalItemReview[];
  /** Draft probes for human review. Unresolved items carry no expectation, so they could never PASS. */
  draft: PermissionProbe[];
}

type ProposedProbe = TestProposal["probes"][number];

/** What every proposed probe is checked against. */
interface ReviewContext {
  issues: readonly string[];
  catalog: MatrixCatalog;
  existing: ReadonlyMap<string, PermissionProbe>;
  actors: ReadonlySet<string>;
  seen: Set<string>;
}

/** Comparison with the approved matrix: a change is rejected, a repeat is a duplicate. */
interface Comparison {
  rejection?: string;
  duplicate?: string;
}

function sourceIssue(ref: { id: string; revision: string }, source: SourceManifest["sources"][number] | undefined): string | undefined {
  if (!source) return `source '${ref.id}' is not in the source manifest`;
  if (source.revision !== ref.revision) return `source '${ref.id}' revision '${ref.revision}' is not the approved '${source.revision}'`;
  if (source.status !== "VERIFIED") return `source '${ref.id}' is ${source.status}, not VERIFIED`;
  return undefined;
}

function proposalIssues(proposal: TestProposal, matrix: PermissionMatrix | undefined, manifest: SourceManifest): string[] {
  const sources = new Map(manifest.sources.map((s) => [s.id, s]));
  const issues = proposal.sourceRefs.map((ref) => sourceIssue(ref, sources.get(ref.id))).filter((i) => i !== undefined);
  return matrix ? issues : [`matrix '${proposal.matrixId}' does not exist; new matrices are created by humans`, ...issues];
}

/** References a proposal may use: only what the matrix and the target already declare. */
function referenceRejections(p: ProposedProbe, ctx: ReviewContext): string[] {
  const rejections: string[] = [];
  if (ctx.issues.length > 0) rejections.push("proposal-level issues");
  if (ctx.seen.has(p.suggestedId)) rejections.push("id is repeated within the proposal");
  ctx.seen.add(p.suggestedId);
  if (!ctx.catalog.operations.has(p.operationId)) rejections.push(`operation '${p.operationId}' is not in the operation registry`);
  if (!ctx.actors.has(p.actorRef)) rejections.push(`actor '${p.actorRef}' is not declared in the matrix (no new identities via proposals)`);
  for (const f of p.fixtureRefs) if (!ctx.catalog.fixtures.has(f)) rejections.push(`fixture '${f}' is unknown`);
  return rejections;
}

const sameCall = (a: ProposedProbe, b: PermissionProbe): boolean => a.actorRef === b.actorRef && a.operationId === b.operationId;
const sameTarget = (a: ProposedProbe, b: PermissionProbe): boolean => a.resourceRef === b.resourceRef && deepEqual(a.input, b.input);

function compareSameId(p: ProposedProbe, approved: PermissionProbe): Comparison {
  const unchanged = sameCall(p, approved) && deepEqual(approved.expected, p.expected);
  if (unchanged) return { duplicate: "identical to an approved probe" };
  return { rejection: "would change an approved probe; approved expectations change only through human review of the matrix" };
}

/** Same actor + operation + input under a new id with a different expectation is the same change in disguise. */
function compareTwin(p: ProposedProbe, existing: ReadonlyMap<string, PermissionProbe>): Comparison {
  const twin = [...existing.values()].find((e) => sameCall(p, e) && sameTarget(p, e));
  if (!twin) return {};
  if (deepEqual(twin.expected, p.expected)) return { duplicate: `covered by approved probe '${twin.id}'` };
  return { rejection: `contradicts approved probe '${twin.id}' (same actor, operation and input, different expectation)` };
}

function compareWithApproved(p: ProposedProbe, existing: ReadonlyMap<string, PermissionProbe>): Comparison {
  const same = existing.get(p.suggestedId);
  return same ? compareSameId(p, same) : compareTwin(p, existing);
}

function openPoints(p: ProposedProbe): string[] {
  const points = p.expected ? [] : ["no expected outcome: a human must decide it from an approved source"];
  if (p.unresolvedQuestions.length > 0) points.push(`${p.unresolvedQuestions.length} unresolved question(s)`);
  return points;
}

function reviewItem(p: ProposedProbe, ctx: ReviewContext): ProposalItemReview {
  const comparison = compareWithApproved(p, ctx.existing);
  const rejections = [...referenceRejections(p, ctx), ...(comparison.rejection ? [comparison.rejection] : [])];
  if (rejections.length > 0) return { suggestedId: p.suggestedId, verdict: "REJECTED", reasons: rejections };
  if (comparison.duplicate) return { suggestedId: p.suggestedId, verdict: "DUPLICATE", reasons: [comparison.duplicate] };
  const points = openPoints(p);
  return { suggestedId: p.suggestedId, verdict: points.length > 0 ? "NEEDS_REVIEW" : "NEW", reasons: points };
}

/** NEEDS_REVIEW drafts carry no expectation, so they could never PASS until a human sets one. */
function draftProbe(p: ProposedProbe, verdict: ProposalVerdict): PermissionProbe {
  return omitUndefined<PermissionProbe>({
    id: p.suggestedId,
    actorRef: p.actorRef,
    operationId: p.operationId,
    input: p.input,
    resourceRef: p.resourceRef,
    expected: verdict === "NEW" ? p.expected : undefined,
    required: p.required,
    severity: p.severity,
    fixtureRefs: p.fixtureRefs,
  });
}

/**
 * Deterministic review of an AI test proposal (plan §14.1). The approved
 * matrix is an input only: nothing here writes to it (SEC-05).
 */
export function reviewProposal(
  proposal: TestProposal,
  matrix: PermissionMatrix | undefined,
  catalog: MatrixCatalog,
  manifest: SourceManifest,
): ProposalReview {
  const ctx: ReviewContext = {
    issues: proposalIssues(proposal, matrix, manifest),
    catalog,
    existing: new Map((matrix?.probes ?? []).map((p) => [p.id, p])),
    actors: new Set((matrix?.actors ?? []).map((a) => a.ref)),
    seen: new Set(),
  };
  const reviewed = proposal.probes.map((p) => ({ p, item: reviewItem(p, ctx) }));
  const items = reviewed.map(({ item }) => item);
  const draft = reviewed
    .filter(({ item }) => item.verdict === "NEW" || item.verdict === "NEEDS_REVIEW")
    .map(({ p, item }) => draftProbe(p, item.verdict));
  return { proposalId: proposal.proposalId, matrixId: proposal.matrixId, generatedBy: proposal.generatedBy, issues: [...ctx.issues], items, draft };
}

export function renderProposalReview(review: ProposalReview, proposal: TestProposal): string {
  const rationale = new Map(proposal.probes.map((p) => [p.suggestedId, p]));
  const lines = [
    `# AI test proposal \`${md(review.proposalId)}\` for matrix \`${md(review.matrixId)}\``,
    "",
    `> Advisory. Generated by ${md(review.generatedBy.model, 100)} (prompt ${md(review.generatedBy.promptVersion, 60)}).`,
    "> Nothing here is enforced until a reviewer copies probes into the approved matrix through a normal code review.",
    "",
  ];
  if (review.issues.length > 0) {
    lines.push("## Proposal rejected", "", ...review.issues.map((i) => `- ${md(i)}`), "");
  }
  lines.push("| Suggested id | Verdict | Reasons | Rationale | Open questions |", "| --- | --- | --- | --- | --- |");
  for (const item of review.items) {
    const p = rationale.get(item.suggestedId);
    lines.push(
      `| \`${md(item.suggestedId)}\` | ${item.verdict} | ${md(item.reasons.join("; "))} | ${md(p?.rationale)} | ${md(p?.unresolvedQuestions.join("; "))} |`,
    );
  }
  lines.push("");
  if (review.draft.length > 0) {
    lines.push(
      "## Draft probes",
      "",
      "Probes marked NEEDS_REVIEW have no `expected` on purpose: the engine classifies them INCONCLUSIVE until a human sets it.",
      "",
      "```yaml",
      // Fences inside values cannot break out: yaml quotes them, and we neutralise backticks anyway.
      stringify({ probes: review.draft }).replaceAll("```", "'''").trimEnd(),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
