import { z } from "zod";
import { HttpTargetSchema } from "../adapters/http/schema.js";
import { TestProposalSchema } from "../ai/proposal.js";
import { TriageReportSchema } from "../ai/triage.js";
import { ProjectConfigSchema } from "../config/schema.js";
import { RunRecordSchema } from "../reporting/run-record.js";
import {
  ManualResultsSchema,
  PermissionMatrixSchema,
  ReleasePolicySchema,
  RouteRecordSchema,
  SourceManifestSchema,
  TestResultSchema,
} from "./schemas.js";

/**
 * JSON Schema for every file format of the kit, generated from the zod
 * contracts (editors and other tools validate with them). Human-written files
 * use the input shape, where defaulted fields are optional.
 */
const FORMATS: Record<string, { schema: z.ZodType; io: "input" | "output" }> = {
  "project-config": { schema: ProjectConfigSchema, io: "input" },
  "permission-matrix": { schema: PermissionMatrixSchema, io: "input" },
  "http-target": { schema: HttpTargetSchema, io: "input" },
  "source-manifest": { schema: SourceManifestSchema, io: "input" },
  "qa-route": { schema: RouteRecordSchema, io: "input" },
  "manual-results": { schema: ManualResultsSchema, io: "input" },
  "release-policy": { schema: ReleasePolicySchema, io: "input" },
  "test-proposal": { schema: TestProposalSchema, io: "input" },
  "triage-report": { schema: TriageReportSchema, io: "input" },
  "test-result": { schema: TestResultSchema, io: "output" },
  "run-record": { schema: RunRecordSchema, io: "output" },
};

export function jsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(FORMATS).map(([name, { schema, io }]) => [
      `${name}.schema.json`,
      {
        $id: `https://qa-agent-kit.local/schemas/${name}.schema.json`,
        ...z.toJSONSchema(schema, { io, unrepresentable: "any" }),
      },
    ]),
  );
}
