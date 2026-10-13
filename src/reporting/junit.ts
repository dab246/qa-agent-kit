import type { TestResult } from "../core/schemas.js";
import { xml } from "./escape.js";

const isError = (r: TestResult): boolean => r.status === "BLOCKED" || r.status === "INCONCLUSIVE";
const isSkip = (r: TestResult): boolean => r.status === "SKIPPED" || r.status === "NOT_APPLICABLE";

function groupBySuite(results: readonly TestResult[]): Map<string, TestResult[]> {
  const suites = new Map<string, TestResult[]>();
  for (const r of results) {
    const key = `${r.lane}:${r.suiteId}`;
    suites.set(key, [...(suites.get(key) ?? []), r]);
  }
  return suites;
}

function properties(r: TestResult): string {
  return [
    r.actorRef && `actor=${r.actorRef}`,
    r.role && `role=${r.role}`,
    r.operationId && `operation=${r.operationId}`,
    `severity=${r.severity}`,
    `required=${r.required}`,
    ...r.evidenceRefs.map((e) => `evidence=${e}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The <failure>/<error>/<skipped> element of a result, or nothing for PASS. */
function outcomeElement(r: TestResult): string | undefined {
  const message = xml(`${r.category ?? r.status}${r.failureReason ? `: ${r.failureReason}` : ""}`);
  if (r.status === "FAIL") return `      <failure message="${message}" type="${xml(r.category ?? "FAIL")}"/>`;
  if (isError(r)) return `      <error message="${message}" type="${xml(r.status)}"/>`;
  return isSkip(r) ? `      <skipped message="${message}"/>` : undefined;
}

function renderCase(suite: string, r: TestResult): string[] {
  const attrs = `classname="${xml(suite)}" name="${xml(r.testId)}" time="${(r.durationMs / 1000).toFixed(3)}"`;
  const outcome = outcomeElement(r);
  return [
    `    <testcase ${attrs}>`,
    ...(outcome ? [outcome] : []),
    `      <system-out>${xml(properties(r))}</system-out>`,
    "    </testcase>",
  ];
}

function renderSuite(suite: string, items: readonly TestResult[]): string[] {
  const count = (pred: (r: TestResult) => boolean): number => items.filter(pred).length;
  const time = items.reduce((t, r) => t + r.durationMs, 0) / 1000;
  const attrs = `name="${xml(suite)}" tests="${items.length}" failures="${count((r) => r.status === "FAIL")}" errors="${count(isError)}" skipped="${count(isSkip)}" time="${time.toFixed(3)}"`;
  return [`  <testsuite ${attrs}>`, ...items.flatMap((r) => renderCase(suite, r)), "  </testsuite>"];
}

/** JUnit XML so any CI can show per-test results. FAIL → failure, BLOCKED/INCONCLUSIVE → error. */
export function renderJUnit(results: readonly TestResult[], name = "qa-agent-kit"): string {
  const suites = [...groupBySuite(results)].flatMap(([suite, items]) => renderSuite(suite, items));
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${xml(name)}">`, ...suites, "</testsuites>", ""].join("\n");
}
