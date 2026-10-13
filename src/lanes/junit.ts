import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { ValidationError } from "../core/errors.js";
import { omitUndefined } from "../core/objects.js";
import type { TestResult, TestStatus } from "../core/schemas.js";

/**
 * Lane intake: UI, E2E and NFR suites run in their own tools (Playwright,
 * Cypress, k6, …) and hand over JUnit XML. Intake normalizes it into the same
 * result model so one gate judges every lane.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "testsuite" || name === "testcase",
  // No entity expansion at all: third-party reports must not be able to inflate (billion laughs).
  processEntities: false,
});

interface JUnitCase {
  name?: string;
  classname?: string;
  time?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}

interface JUnitSuite {
  name?: string;
  testcase?: JUnitCase[];
  testsuite?: JUnitSuite[];
}

function messageOf(node: unknown): string | undefined {
  if (node === undefined) return undefined;
  if (typeof node === "string") return node.slice(0, 500);
  if (node !== null && typeof node === "object") {
    const n = node as Record<string, unknown>;
    const text = (n["message"] ?? n["#text"] ?? "") as string;
    return String(text).slice(0, 500);
  }
  return "";
}

export interface IntakeOptions {
  runId: string;
  lane: string;
  required: boolean;
  /** Paths are stored relative to this directory as evidence references. */
  baseDir: string;
  now: Date;
}

function rootSuites(doc: Record<string, unknown>, file: string): JUnitSuite[] {
  const top = doc["testsuites"] as JUnitSuite | undefined;
  const bare = doc["testsuite"] as JUnitSuite[] | undefined;
  const roots = [...(top?.testsuite ?? []), ...(bare ?? [])];
  if (roots.length === 0) throw new ValidationError(`JUnit report ${file} has no <testsuite>`);
  return roots;
}

function caseOutcome(tc: JUnitCase): Pick<TestResult, "status" | "category" | "failureReason"> {
  const failure = tc.failure ?? tc.error;
  if (failure !== undefined) return omitUndefined({ status: "FAIL", category: "TEST_FAILED", failureReason: messageOf(failure) || undefined });
  if (tc.skipped !== undefined) return omitUndefined({ status: "SKIPPED", category: "SKIPPED_BY_RUNNER", failureReason: messageOf(tc.skipped) || undefined });
  return { status: "PASS" };
}

/** Parameterized/retried cases repeat names; suffix them so each run stays one distinct result. */
function uniqueId(seen: Map<string, number>, suiteId: string, tc: JUnitCase): string {
  const baseId = tc.classname ? `${tc.classname}.${tc.name ?? "test"}` : (tc.name ?? "test");
  const key = `${suiteId}\u0000${baseId}`;
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count === 1 ? baseId : `${baseId}#${count}`;
}

export function parseJUnit(xml: string, file: string, options: IntakeOptions): TestResult[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new ValidationError(`cannot parse JUnit report ${file}`, [(error as Error).message]);
  }
  const evidenceRef = relative(options.baseDir, file).split("\\").join("/");
  const at = options.now.toISOString();
  const results: TestResult[] = [];
  const seen = new Map<string, number>();
  const toResult = (suiteId: string, tc: JUnitCase): TestResult => ({
    runId: options.runId,
    lane: options.lane,
    suiteId,
    testId: uniqueId(seen, suiteId, tc),
    required: options.required,
    ...caseOutcome(tc),
    severity: "normal",
    startedAt: at,
    finishedAt: at,
    durationMs: Math.round(Number(tc.time ?? 0) * 1000) || 0,
    evidenceRefs: [evidenceRef],
  });
  const visit = (suite: JUnitSuite, prefix: string): void => {
    const name = suite.name ?? "suite";
    const suiteId = prefix ? `${prefix}/${name}` : name;
    for (const tc of suite.testcase ?? []) results.push(toResult(suiteId, tc));
    for (const child of suite.testsuite ?? []) visit(child, suiteId);
  };
  rootSuites(doc, file).forEach((s) => visit(s, ""));
  return results;
}

/** Third-party reports are read whole; anything larger is rejected rather than risking memory. */
export const MAX_JUNIT_BYTES = 50 * 1024 * 1024;

export async function ingestJUnit(
  files: readonly string[],
  options: IntakeOptions,
): Promise<{ results: TestResult[]; missingFiles: string[] }> {
  const results: TestResult[] = [];
  const missingFiles: string[] = [];
  for (const file of files) {
    let xml: string;
    try {
      const { size } = await stat(file);
      if (size > MAX_JUNIT_BYTES) throw new ValidationError(`JUnit report ${file} is ${size} bytes, above the ${MAX_JUNIT_BYTES} limit`);
      xml = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      // A missing report is not an empty pass: the gate sees zero results for the lane.
      missingFiles.push(file);
      continue;
    }
    results.push(...parseJUnit(xml, file, options));
  }
  return { results, missingFiles };
}
