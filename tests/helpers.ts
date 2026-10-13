import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTarget, type FakeOperation, type FakeTargetSpec } from "../src/adapters/fake/fake-target.js";
import type { OperationResponse } from "../src/core/interfaces.js";
import {
  PermissionMatrixSchema,
  ReleasePolicySchema,
  type PermissionMatrix,
  type ReleasePolicy,
  type TestResult,
} from "../src/core/schemas.js";
import type { EvidenceWriter } from "../src/evidence/writer.js";
import type { DriverOptions, RunContext } from "../src/permission/driver.js";
import type { GateInput } from "../src/release-gate/gate.js";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export async function tempDir(prefix = "qak-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Every file under `dir`, concatenated: used to prove a value never reached disk. */
export async function readTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  return (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
}

export const respond = (status: number, body?: unknown, extra: Partial<OperationResponse> = {}): OperationResponse => ({
  status,
  headers: {},
  ...(body !== undefined && { body }),
  ...extra,
});

type ProbeInput = Record<string, unknown> & { id: string };

/** Matrix parsed through the real schema so defaults (required, severity, assertions) apply. */
export function matrix(probes: ProbeInput[], extra: Record<string, unknown> = {}): PermissionMatrix {
  return PermissionMatrixSchema.parse({
    schemaVersion: 1,
    matrixId: "m1",
    version: 1,
    sourceRefs: [{ id: "policy", revision: "r1" }],
    actors: [
      { ref: "user", role: "regular-user" },
      { ref: "admin", role: "administrator" },
    ],
    probes: probes.map((p) => ({ actorRef: "user", operationId: "op.read", ...p })),
    ...extra,
  });
}

export const deny = { kind: "http", status: 403 } as const;
export const allow = { kind: "http", status: 200 } as const;

export function fakeTarget(operations: Record<string, FakeOperation>, overrides: Partial<FakeTargetSpec> = {}): FakeTarget {
  return new FakeTarget({
    actors: { user: { role: "regular-user" }, admin: { role: "administrator" } },
    operations,
    ...overrides,
  });
}

export class MemoryEvidence implements EvidenceWriter {
  readonly written: Array<{ result: TestResult; details: Record<string, unknown> }> = [];
  constructor(private readonly failWith?: string) {}
  async write(result: TestResult, details: Record<string, unknown>): Promise<string[]> {
    if (this.failWith) throw new Error(this.failWith);
    this.written.push({ result: structuredClone(result), details });
    return [`evidence/${result.testId}.json`];
  }
}

export function runContext(signal: AbortSignal = new AbortController().signal): RunContext {
  return { runId: "run-1", commitSha: COMMIT, environment: "test", signal };
}

export function driverOptions(target: FakeTarget, evidence: EvidenceWriter = new MemoryEvidence(), extra: Partial<DriverOptions> = {}): DriverOptions {
  return { target, evidence, defaultTimeoutMs: 2_000, cleanupTimeoutMs: 2_000, stopOnCriticalViolation: false, ...extra };
}

export function policy(extra: Record<string, unknown> = {}): ReleasePolicy {
  return ReleasePolicySchema.parse({
    schemaVersion: 1,
    policyVersion: "test-1",
    lifecycle: { requireIntakeAccepted: false, requireCostValueGo: false, requireManualE2EPass: false },
    ...extra,
  });
}

/** Gate input with every lifecycle prerequisite satisfied, so a test only varies what it is about. */
export function gateInput(results: TestResult[], extra: Partial<GateInput> = {}): GateInput {
  return {
    results,
    plannedRequired: [],
    policy: policy(),
    commitSha: COMMIT,
    resultsCommitSha: COMMIT,
    sources: { approved: true, issues: [] },
    route: undefined,
    manual: { cases: [], results: [] },
    lifecycleFailures: [],
    missingLaneReports: [],
    now: new Date("2026-10-13T00:00:00Z"),
    ...extra,
  };
}

export function result(extra: Partial<TestResult> = {}): TestResult {
  return {
    runId: "run-1",
    lane: "permission",
    suiteId: "m1",
    testId: "t1",
    required: true,
    status: "PASS",
    severity: "high",
    startedAt: "2026-10-13T00:00:00Z",
    finishedAt: "2026-10-13T00:00:00Z",
    durationMs: 1,
    evidenceRefs: ["evidence/t1.json"],
    ...extra,
  };
}
