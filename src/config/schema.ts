import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "../core/schemas.js";

const TimeoutSchema = z.number().int().min(100).max(600_000);

/** Guard rails against pointing the kit at the wrong system. */
const SafetySchema = z
  .strictObject({
    allowedEnvironments: z.array(IdSchema).min(1),
    /** Hostnames the target base URL may resolve to. Empty means "not enforced". */
    allowedHosts: z.array(z.string().min(1)).default([]),
  })
  .prefault({ allowedEnvironments: ["local", "test", "staging"] });

const RoutingSchema = z
  .strictObject({
    route: z.string().min(1).optional(),
    /** Path A/B/C/D… proposed by S0 and confirmed by the QA Lead; each implies the lanes to run. */
    paths: z.record(z.string(), z.strictObject({ description: z.string(), lanes: z.array(IdSchema).min(1) })).default({}),
  })
  .prefault({});

const PermissionSchema = z.strictObject({
  target: z.string().min(1),
  matrices: z.array(z.string().min(1)).min(1),
  execution: z
    .strictObject({
      defaultTimeoutMs: TimeoutSchema.default(10_000),
      cleanupTimeoutMs: TimeoutSchema.default(30_000),
      stopOnCriticalViolation: z.boolean().default(false),
    })
    .prefault({}),
});

const TestPacksSchema = z
  .strictObject({
    files: z.array(z.string().min(1)).default([]),
    manualResults: z.string().min(1).optional(),
  })
  .prefault({});

/** Lanes executed by other tools (Playwright, k6, …) and ingested through JUnit XML. */
const LanesSchema = z
  .record(
    IdSchema,
    z.strictObject({
      junit: z.array(z.string().min(1)).min(1),
      required: z.boolean().default(true),
    }),
  )
  .default({});

const ImpactSchema = z
  .strictObject({
    rules: z
      .array(
        z.strictObject({
          paths: z.array(z.string().min(1)).min(1),
          matrices: z.array(IdSchema).default([]),
          lanes: z.array(IdSchema).default([]),
        }),
      )
      .default([]),
    alwaysRun: z.array(IdSchema).default([]),
    /** Files no rule claims make impact uncertain: run everything rather than assume safety. */
    onUnmatched: z.enum(["run-all", "ignore"]).default("run-all"),
  })
  .prefault({});

const EvidenceSchema = z
  .strictObject({
    directory: z.string().min(1).default("artifacts/qa"),
    includeResponseBodies: z.boolean().default(false),
    maxBodyBytes: z.number().int().min(0).max(1_048_576).default(16_384),
    redactHeaders: z.array(z.string()).default(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]),
    redactFields: z
      .array(z.string())
      .default(["password", "passwd", "secret", "token", "apikey", "api_key", "authorization", "cookie", "session", "credential", "otp"]),
  })
  .prefault({});

const AiSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    proposalsDirectory: z.string().default("proposals/pending"),
    /** Never true in the MVP: approved matrices change only through human review. */
    allowChangeApprovedMatrix: z.literal(false).default(false),
  })
  .prefault({});

/** `qa-agent-kit.yaml`: the single entry point of a project's QA setup. Paths are relative to this file. */
export const ProjectConfigSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  project: z.strictObject({ id: IdSchema, environment: IdSchema }),
  safety: SafetySchema,
  sources: z.strictObject({ manifest: z.string().min(1) }),
  routing: RoutingSchema,
  permission: PermissionSchema.optional(),
  testPacks: TestPacksSchema,
  lanes: LanesSchema,
  impact: ImpactSchema,
  evidence: EvidenceSchema,
  releaseGate: z.strictObject({ policy: z.string().min(1) }),
  ai: AiSchema,
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
