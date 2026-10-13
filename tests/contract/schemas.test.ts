import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HttpTargetSchema } from "../../src/adapters/http/schema.js";
import { ProjectConfigSchema } from "../../src/config/schema.js";
import { jsonSchemas } from "../../src/core/json-schemas.js";
import {
  ManualResultsSchema,
  PermissionMatrixSchema,
  ReleasePolicySchema,
  RouteRecordSchema,
  SourceManifestSchema,
} from "../../src/core/schemas.js";

const SCHEMAS = new URL("../../schemas/", import.meta.url);
const EXAMPLE = new URL("../../examples/minimal-permission-suite/", import.meta.url);

describe("published JSON schemas", () => {
  it("match the zod contracts (run `npm run schemas` after changing a contract)", async () => {
    const generated = jsonSchemas();
    expect((await readdir(SCHEMAS)).filter((f) => f.endsWith(".json")).sort()).toEqual(Object.keys(generated).sort());
    for (const [file, schema] of Object.entries(generated)) {
      expect(JSON.parse(await readFile(new URL(file, SCHEMAS), "utf8")), file).toEqual(schema);
    }
  });
});

describe("example suite conforms to every contract", () => {
  it.each([
    ["qa-agent-kit.yaml", ProjectConfigSchema],
    ["target.yaml", HttpTargetSchema],
    ["matrices/settings-permissions.yaml", PermissionMatrixSchema],
    ["source-manifest.yaml", SourceManifestSchema],
    ["qa-route.yaml", RouteRecordSchema],
    ["manual-results.yaml", ManualResultsSchema],
    ["release-policy.yaml", ReleasePolicySchema],
  ] as const)("%s", async (file, schema) => {
    const parsed = schema.safeParse(parse(await readFile(new URL(file, EXAMPLE), "utf8")));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe("contracts reject invalid examples", () => {
  const probe = { id: "p", actorRef: "u", operationId: "op", expected: { kind: "http", status: 403 } };
  const base = {
    schemaVersion: 1,
    matrixId: "m",
    version: 1,
    sourceRefs: [{ id: "s", revision: "1" }],
    actors: [{ ref: "u", role: "r" }],
    probes: [probe],
  };
  it.each([
    ["future schema version", { ...base, schemaVersion: 2 }],
    ["no source refs", { ...base, sourceRefs: [] }],
    ["status out of range", { ...base, probes: [{ ...probe, expected: { kind: "http", status: 99 } }] }],
    ["unknown assertion kind", { ...base, probes: [{ ...probe, expected: { kind: "http", status: 403, assertions: [{ kind: "js", code: "1" }] } }] }],
    ["id with path separator", { ...base, matrixId: "../m" }],
    ["fixture id with a dot", { ...base, probes: [{ ...probe, fixtureRefs: ["a.b"] }] }],
    ["unknown top-level key", { ...base, hooks: ["x"] }],
    ["timeout below minimum", { ...base, probes: [{ ...probe, timeoutMs: 1 }] }],
  ])("%s", (_name, data) => {
    expect(PermissionMatrixSchema.safeParse(data).success).toBe(false);
  });

  it("AI may never be allowed to change approved matrices", () => {
    const config = parse(`schemaVersion: 1
project: { id: p, environment: test }
sources: { manifest: m.yaml }
releaseGate: { policy: p.yaml }
ai: { allowChangeApprovedMatrix: true }`);
    expect(ProjectConfigSchema.safeParse(config).success).toBe(false);
  });

  it("credentials cannot be written into the target config, only env var names", () => {
    const target = {
      schemaVersion: 1,
      baseUrl: "http://localhost",
      operations: {},
      actors: { u: { role: "r", auth: { kind: "bearer-env", tokenEnv: "eyJhbGciOiJIUzI1NiJ9.payload.sig" } } },
    };
    expect(HttpTargetSchema.safeParse(target).success).toBe(false);
    expect(HttpTargetSchema.safeParse({ ...target, actors: { u: { role: "r", auth: { kind: "bearer", token: "abc" } } } }).success).toBe(false);
  });
});
