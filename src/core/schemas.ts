/**
 * Versioned contracts of the kit. Every file a human or an AI writes is parsed
 * through one of these schemas before the engine trusts it; `schemas/*.json`
 * is generated from here (see scripts/generate-schemas.mjs).
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

// Anchored, single character class, no nested quantifier: linear time.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Fixture ids are addressed as `{{fixture.<id>.<path>}}`, so they cannot contain dots.
const FIXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const IdSchema = z
  .string()
  .regex(SAFE_ID, "must start with a letter or digit and contain only letters, digits, '.', '_', ':' or '-' (max 128)");
export const FixtureIdSchema = z
  .string()
  .regex(FIXTURE_ID, "fixture ids contain only letters, digits, '_' or '-' (max 64)");

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const TEST_STATUSES = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "SKIPPED", "NOT_APPLICABLE"] as const;
export const TestStatusSchema = z.enum(TEST_STATUSES);
export type TestStatus = z.infer<typeof TestStatusSchema>;

/** Why a result is not PASS. Maps the V1/V2/V3/SKIP diagram labels onto stable codes. */
export const RESULT_CATEGORIES = [
  // FAIL
  "PRIVILEGE_ESCALATION", // V2: denial expected, operation succeeded
  "DATA_DISCLOSURE", // denial returned, but the body still carried protected data
  "UNEXPECTED_DENIAL", // success expected, operation was denied
  "STATUS_MISMATCH",
  "ERROR_CODE_MISMATCH",
  "ASSERTION_FAILED",
  "TEST_FAILED", // imported lane result
  // BLOCKED
  "TIMEOUT",
  "EXECUTION_ERROR",
  "SEED_FAILED",
  "ACTOR_UNAVAILABLE",
  "ACTOR_MISMATCH",
  "CANCELLED",
  // INCONCLUSIVE
  "NO_EXPECTATION", // diagram SKIP: no approved expectation, never PASS
  "UNRESOLVED_REFERENCE", // V3: fixture/master-data ids unresolved
  "BODY_INCOMPLETE", // response body truncated/unparseable, so assertions cannot be proven
  // SKIPPED
  "STOPPED_AFTER_CRITICAL",
  "SOURCES_NOT_APPROVED",
  "SKIPPED_BY_RUNNER",
] as const;
export const ResultCategorySchema = z.enum(RESULT_CATEGORIES);
export type ResultCategory = z.infer<typeof ResultCategorySchema>;

export const SeveritySchema = z.enum(["critical", "high", "normal"]);
export type Severity = z.infer<typeof SeveritySchema>;

const HttpStatusSchema = z.number().int().min(100).max(599);

export const ResponseAssertionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("json-equals"), path: z.string().min(1), expected: z.unknown() }),
  z.strictObject({ kind: z.literal("json-exists"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("json-not-exists"), path: z.string().min(1) }),
]);
export type ResponseAssertion = z.infer<typeof ResponseAssertionSchema>;

export const ExpectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    status: z.union([HttpStatusSchema, z.array(HttpStatusSchema).min(1)]),
    assertions: z.array(ResponseAssertionSchema).default([]),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.string().min(1),
    assertions: z.array(ResponseAssertionSchema).default([]),
  }),
]);
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

export const TestResultSchema = z.strictObject({
  runId: z.string().min(1),
  lane: IdSchema,
  suiteId: z.string().min(1),
  suiteVersion: z.union([z.string(), z.number()]).optional(),
  testId: z.string().min(1),
  title: z.string().optional(),
  required: z.boolean(),
  status: TestStatusSchema,
  category: ResultCategorySchema.optional(),
  severity: SeveritySchema,
  actorRef: z.string().optional(),
  role: z.string().optional(),
  operationId: z.string().optional(),
  resourceRef: z.string().optional(),
  expected: ExpectedOutcomeSchema.optional(),
  actual: z
    .strictObject({
      httpStatus: z.number().int().optional(),
      errorCode: z.string().optional(),
    })
    .optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().min(0),
  evidenceRefs: z.array(z.string()),
  evidenceError: z.string().optional(),
  failureReason: z.string().optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export function testKey(r: Pick<TestResult, "lane" | "suiteId" | "testId">): string {
  return `${r.lane}:${r.suiteId}:${r.testId}`;
}

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

export const SourceRefSchema = z.strictObject({ id: IdSchema, revision: z.string().min(1) });

export const PermissionProbeSchema = z.strictObject({
  id: IdSchema,
  title: z.string().optional(),
  actorRef: IdSchema,
  operationId: IdSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  resourceRef: z.string().optional(),
  /** Absent expectation is allowed in the file but always classifies INCONCLUSIVE. */
  expected: ExpectedOutcomeSchema.optional(),
  required: z.boolean().default(true),
  severity: SeveritySchema.default("high"),
  fixtureRefs: z.array(FixtureIdSchema).default([]),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
export type PermissionProbe = z.infer<typeof PermissionProbeSchema>;

export const PermissionMatrixSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  matrixId: IdSchema,
  version: z.number().int().positive(),
  description: z.string().optional(),
  area: z.string().optional(),
  sourceRefs: z.array(SourceRefSchema).min(1),
  actors: z.array(z.strictObject({ ref: IdSchema, role: IdSchema })).min(1),
  probes: z.array(PermissionProbeSchema).min(1),
});
export type PermissionMatrix = z.infer<typeof PermissionMatrixSchema>;

// ---------------------------------------------------------------------------
// Phase 0: source manifest
// ---------------------------------------------------------------------------

export const SourceManifestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  manifestId: IdSchema,
  sources: z
    .array(
      z.strictObject({
        id: IdSchema,
        type: z.enum(["requirement", "policy", "api-contract", "test-pack", "design", "other"]),
        revision: z.string().min(1),
        status: z.enum(["VERIFIED", "ASSUMPTION", "OBSOLETE", "UNVERIFIED"]),
        /** Optional file whose content is pinned by sha256: a change re-opens Phase 0. */
        path: z.string().optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
  assumptions: z
    .array(z.strictObject({ id: IdSchema, statement: z.string(), owner: z.string().optional(), resolved: z.boolean() }))
    .default([]),
  approval: z.strictObject({
    status: z.enum(["APPROVED", "PENDING", "REJECTED"]),
    approvedBy: z.string().optional(),
    approvedAt: z.string().optional(),
    reference: z.string().optional(),
  }),
});
export type SourceManifest = z.infer<typeof SourceManifestSchema>;

// ---------------------------------------------------------------------------
// Step 1 (S0): route record written by the QA Lead
// ---------------------------------------------------------------------------

const DecisionRecord = z.strictObject({
  decidedBy: z.string().min(1).optional(),
  decidedAt: z.string().optional(),
  rationale: z.string().optional(),
});

export const RouteRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  routeId: IdSchema,
  path: z.string().min(1),
  owner: z.string().min(1),
  scope: z.string().optional(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  lanes: z.array(IdSchema).min(1),
  gaps: z.array(z.string()).default([]),
  intake: DecisionRecord.extend({ status: z.enum(["ACCEPTED", "PENDING", "REJECTED"]) }),
  costValue: DecisionRecord.extend({ decision: z.enum(["GO", "PENDING", "NO_GO"]) }),
});
export type RouteRecord = z.infer<typeof RouteRecordSchema>;

// ---------------------------------------------------------------------------
// Phase 1: manual E2E results (test cases themselves live in Markdown)
// ---------------------------------------------------------------------------

export const ManualResultsSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  results: z
    .array(
      z.strictObject({
        tcId: IdSchema,
        status: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
        tester: z.string().min(1),
        executedAt: z.string().min(1),
        commitSha: z.string().optional(),
        environment: z.string().optional(),
        evidence: z.array(z.string()).default([]),
        notes: z.string().optional(),
      }),
    )
    .default([]),
});
export type ManualResults = z.infer<typeof ManualResultsSchema>;
export type ManualResult = ManualResults["results"][number];

// ---------------------------------------------------------------------------
// Release policy
// ---------------------------------------------------------------------------

export const ReleasePolicySchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  policyVersion: z.string().min(1),
  /** Extra required tests, as `lane:suite:test` keys, on top of probes marked `required`. */
  requiredTests: z.array(z.string()).default([]),
  blockOnStatuses: z.array(TestStatusSchema).default(["FAIL", "BLOCKED", "INCONCLUSIVE", "SKIPPED"]),
  optionalFailures: z.enum(["warn", "block"]).default("warn"),
  criticalAlwaysBlocks: z.boolean().default(true),
  requireEvidence: z.boolean().default(true),
  requireSourceApproval: z.boolean().default(true),
  requireCleanupSuccess: z.boolean().default(true),
  /** A required result older than this commit is stale and cannot satisfy the gate. */
  requireResultsForCommit: z.boolean().default(true),
  lifecycle: z
    .strictObject({
      requireIntakeAccepted: z.boolean().default(true),
      requireCostValueGo: z.boolean().default(true),
      requireManualE2EPass: z.boolean().default(true),
    })
    .prefault({}),
  lanes: z
    .record(IdSchema, z.strictObject({ required: z.boolean().default(true), minTests: z.number().int().min(0).default(1) }))
    .default({}),
  exceptions: z
    .array(
      z.strictObject({
        testKey: z.string().min(1),
        reason: z.string().min(1),
        approvedBy: z.string().min(1),
        commitSha: z.string().min(7),
        expiresAt: z.string().min(1),
      }),
    )
    .default([]),
});
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;
