import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { ValidationError } from "../core/errors.js";
import type { FilePath } from "../core/files.js";
import { omitUndefined } from "../core/objects.js";
import { decodeXmlText } from "./xml-text.js";
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

/** Text of a <failure>/<error>/<skipped> element: its message attribute, else its body. */
function messageOf(node: unknown): string | undefined {
  const raw = typeof node === "object" && node !== null ? ((node as Record<string, unknown>)["message"] ?? (node as Record<string, unknown>)["#text"]) : node;
  const text = typeof raw === "string" ? decodeXmlText(raw).slice(0, 500) : "";
  return text === "" ? undefined : text;
}

export interface IntakeOptions {
  runId: string;
  lane: string;
  required: boolean;
  /** Paths are stored relative to this directory as evidence references. */
  baseDir: FilePath;
  now: Date;
}

/** A suite as the intake addresses it: nested suites get `parent/child` ids. */
interface SuiteRef {
  id: string;
  name: string;
}

function rootSuites(doc: Record<string, unknown>, file: FilePath): JUnitSuite[] {
  const top = doc["testsuites"] as JUnitSuite | undefined;
  const bare = doc["testsuite"] as JUnitSuite[] | undefined;
  const roots = [...(top?.testsuite ?? []), ...(bare ?? [])];
  if (roots.length === 0) throw new ValidationError(`JUnit report ${file} has no <testsuite>`);
  return roots;
}

function caseOutcome(tc: JUnitCase): Pick<TestResult, "status" | "category" | "failureReason"> {
  const failure = tc.failure ?? tc.error;
  if (failure !== undefined) return omitUndefined({ status: "FAIL", category: "TEST_FAILED", failureReason: messageOf(failure) });
  if (tc.skipped === undefined) return { status: "PASS" };
  return omitUndefined({ status: "SKIPPED", category: "SKIPPED_BY_RUNNER", failureReason: messageOf(tc.skipped) });
}

/**
 * `classname.name`, or just `name` when the classname adds nothing (Vitest and
 * Jest repeat the file path, which is already the suite name).
 */
function baseIdOf(suite: SuiteRef, tc: JUnitCase): string {
  const name = decodeXmlText(tc.name ?? "test");
  const classname = decodeXmlText(tc.classname ?? "");
  return classname === "" || classname === suite.name ? name : `${classname}.${name}`;
}

/** Parameterized/retried cases repeat names; suffix them so each run stays one distinct result. */
function uniqueId(seen: Map<string, number>, suite: SuiteRef, tc: JUnitCase): string {
  const baseId = baseIdOf(suite, tc);
  const key = `${suite.id}\u0000${baseId}`;
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count === 1 ? baseId : `${baseId}#${count}`;
}

function parseXml(xml: string, file: FilePath): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new ValidationError(`cannot parse JUnit report ${file}`, [(error as Error).message]);
  }
}

export function parseJUnit(xml: string, file: FilePath, options: IntakeOptions): TestResult[] {
  const doc = parseXml(xml, file);
  const evidenceRef = relative(options.baseDir, file).split("\\").join("/");
  const at = options.now.toISOString();
  const results: TestResult[] = [];
  const seen = new Map<string, number>();
  const toResult = (suite: SuiteRef, tc: JUnitCase): TestResult => ({
    runId: options.runId,
    lane: options.lane,
    suiteId: suite.id,
    testId: uniqueId(seen, suite, tc),
    required: options.required,
    ...caseOutcome(tc),
    severity: "normal",
    startedAt: at,
    finishedAt: at,
    durationMs: Math.round(Number(tc.time ?? 0) * 1000) || 0,
    evidenceRefs: [evidenceRef],
  });
  const visit = (suite: JUnitSuite, parent: SuiteRef | undefined): void => {
    const name = decodeXmlText(suite.name ?? "suite");
    const ref: SuiteRef = { id: parent ? `${parent.id}/${name}` : name, name };
    for (const tc of suite.testcase ?? []) results.push(toResult(ref, tc));
    for (const child of suite.testsuite ?? []) visit(child, ref);
  };
  rootSuites(doc, file).forEach((s) => visit(s, undefined));
  return results;
}

/** Third-party reports are read whole; anything larger is rejected rather than risking memory. */
export const MAX_JUNIT_BYTES = 50 * 1024 * 1024;

/** The report text, or undefined when the file does not exist (a lane that produced nothing). */
async function readReport(file: FilePath): Promise<string | undefined> {
  try {
    const { size } = await stat(file);
    if (size > MAX_JUNIT_BYTES) throw new ValidationError(`JUnit report ${file} is ${size} bytes, above the ${MAX_JUNIT_BYTES} limit`);
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return undefined;
  }
}

export async function ingestJUnit(
  files: readonly FilePath[],
  options: IntakeOptions,
): Promise<{ results: TestResult[]; missingFiles: FilePath[] }> {
  const results: TestResult[] = [];
  const missingFiles: FilePath[] = [];
  for (const file of files) {
    const xml = await readReport(file);
    // A missing report is not an empty pass: the gate sees zero results for the lane.
    if (xml === undefined) missingFiles.push(file);
    else results.push(...parseJUnit(xml, file, options));
  }
  return { results, missingFiles };
}
