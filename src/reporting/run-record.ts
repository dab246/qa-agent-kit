import { z } from "zod";
import {
  ManualResultsSchema,
  RouteRecordSchema,
  SchemaVersionSchema,
  SourceRefSchema,
  TestResultSchema,
} from "../core/schemas.js";

export const TestCaseSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  type: z.enum(["manual-e2e", "automated", "review"]),
  lane: z.string(),
  priority: z.string(),
  required: z.boolean(),
  automation: z.array(z.string()),
  file: z.string(),
  line: z.number(),
});

/**
 * Everything needed to reconstruct and re-gate a run: inputs (plan, sources,
 * route, manual results), outputs (results, lifecycle) and provenance.
 */
export const RunRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kitVersion: z.string(),
  runId: z.string(),
  project: z.strictObject({ id: z.string(), environment: z.string() }),
  commitSha: z.string(),
  pullRequest: z
    .strictObject({
      provider: z.string(),
      id: z.string().optional(),
      /** Untrusted text: rendered escaped, never interpreted. */
      title: z.string().optional(),
      baseSha: z.string().optional(),
      headSha: z.string().optional(),
    })
    .optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  plan: z.strictObject({
    mode: z.enum(["all", "selected"]),
    matrices: z.array(z.string()),
    reasons: z.array(z.string()),
    requiredKeys: z.array(z.string()),
    changedFiles: z.array(z.string()).optional(),
  }),
  matrices: z.array(z.strictObject({ matrixId: z.string(), version: z.number(), sourceRefs: z.array(SourceRefSchema) })),
  sources: z.strictObject({
    manifestId: z.string(),
    approved: z.boolean(),
    issues: z.array(z.string()),
    changedSources: z.array(z.string()),
  }),
  route: RouteRecordSchema.optional(),
  manual: z.strictObject({ cases: z.array(TestCaseSchema), results: ManualResultsSchema.shape.results }),
  lifecycle: z.array(
    z.strictObject({
      matrixId: z.string(),
      phase: z.enum(["seed", "actor", "cleanup", "dispose"]),
      ref: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
  missingLaneReports: z.array(z.string()),
  results: z.array(TestResultSchema),
  evidenceIndex: z.array(z.strictObject({ ref: z.string(), sha256: z.string(), bytes: z.number() })),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
