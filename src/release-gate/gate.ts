import {
  TEST_STATUSES,
  testKey,
  type ManualResult,
  type ReleasePolicy,
  type RouteRecord,
  type TestResult,
  type TestStatus,
} from "../core/schemas.js";
import type { TestCase } from "../lifecycle/test-pack.js";
import { isCriticalCategory } from "../permission/classify.js";

export type Verdict = "GREEN" | "AMBER" | "RED";
export type GateDecision = "GO" | "NO_GO";

export interface GateReason {
  /** red = definite failure, amber = missing/blocked/unapproved, warn = recorded, does not block. */
  level: "red" | "amber" | "warn";
  code: string;
  message: string;
  testKey?: string;
}

export interface GateInput {
  results: readonly TestResult[];
  /** Required test keys from the execution plan (required probes of selected matrices). */
  plannedRequired: readonly string[];
  policy: ReleasePolicy;
  commitSha: string;
  /** Commit the results were produced for. */
  resultsCommitSha: string;
  sources: { approved: boolean; issues: readonly string[] };
  route: RouteRecord | undefined;
  manual: { cases: readonly TestCase[]; results: readonly ManualResult[] };
  lifecycleFailures: ReadonlyArray<{ phase: string; ref: string; error?: string }>;
  missingLaneReports: readonly string[];
  now: Date;
}

export interface ReleaseGateResult {
  decision: GateDecision;
  verdict: Verdict;
  reasons: GateReason[];
  waived: Array<{ testKey: string; reason: string; approvedBy: string; expiresAt: string }>;
  counts: Record<TestStatus, number>;
  policyVersion: string;
  commitSha: string;
  evaluatedAt: string;
}

/** Full or abbreviated (≥ 7 chars) SHAs of the same commit. */
function sameCommit(a: string, b: string): boolean {
  const short = Math.min(a.length, b.length);
  return short < 7 ? a === b : a.slice(0, short) === b.slice(0, short);
}

type AddReason = (level: GateReason["level"], code: string, message: string, key?: string) => void;
type ResultIndex = ReadonlyMap<string, TestResult>;

const isKnownStatus = (status: string): status is TestStatus => (TEST_STATUSES as readonly string[]).includes(status);
const isCriticalFailure = (r: TestResult): boolean => r.status === "FAIL" && isCriticalCategory(r.category);
const lacksEvidence = (r: TestResult): boolean => r.evidenceRefs.length === 0 || r.evidenceError !== undefined;

/** One result per test key; unknown statuses and duplicates are reasons, never silently merged. */
function indexResults(results: readonly TestResult[], add: AddReason): { byKey: Map<string, TestResult>; counts: Record<TestStatus, number> } {
  const counts = Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as Record<TestStatus, number>;
  const byKey = new Map<string, TestResult>();
  for (const result of results) {
    const key = testKey(result);
    if (!isKnownStatus(result.status)) {
      add("amber", "UNKNOWN_STATUS", `unknown status '${String(result.status)}'`, key);
      continue;
    }
    counts[result.status]++;
    if (byKey.has(key)) {
      // Two results for one test could let a stale PASS mask a fresh FAIL.
      add("amber", "DUPLICATE_RESULT", "more than one result for the same test", key);
      continue;
    }
    byKey.set(key, result);
  }
  return { byKey, counts };
}

/** Exceptions: bound to a commit, expiring, approved by a named person; never for critical findings. */
function activeExceptions(input: GateInput, add: AddReason): ReleaseGateResult["waived"] {
  const waived: ReleaseGateResult["waived"] = [];
  for (const ex of input.policy.exceptions) {
    const expires = Date.parse(ex.expiresAt);
    if (Number.isNaN(expires) || expires <= input.now.getTime()) {
      add("warn", "EXCEPTION_EXPIRED", `exception for ${ex.testKey} expired or has an invalid date (${ex.expiresAt})`);
    } else if (!sameCommit(ex.commitSha, input.commitSha)) {
      add("warn", "EXCEPTION_OTHER_COMMIT", `exception for ${ex.testKey} was approved for ${ex.commitSha}`);
    } else {
      waived.push({ testKey: ex.testKey, reason: ex.reason, approvedBy: ex.approvedBy, expiresAt: ex.expiresAt });
    }
  }
  return waived;
}

/** Critical violations block regardless of required flag or waiver. */
function checkCritical(byKey: ResultIndex, input: GateInput, add: AddReason): void {
  if (!input.policy.criticalAlwaysBlocks) return;
  for (const [key, r] of byKey) {
    if (isCriticalFailure(r)) add("red", "CRITICAL_VIOLATION", `${r.category}: ${r.failureReason ?? "critical failure"}`, key);
  }
}

function requiredKeys(input: GateInput, byKey: ResultIndex): Set<string> {
  const required = new Set<string>([...input.plannedRequired, ...input.policy.requiredTests]);
  for (const [key, r] of byKey) if (r.required) required.add(key);
  return required;
}

interface RequiredCheck {
  input: GateInput;
  add: AddReason;
  byKey: ResultIndex;
  waivedKeys: ReadonlySet<string>;
}

function blockingDetail(r: TestResult): string {
  return `${r.category ?? r.status}${r.failureReason ? `: ${r.failureReason}` : ""}`;
}

function checkRequiredStatus(check: RequiredCheck, key: string, r: TestResult): void {
  const blocking = check.input.policy.blockOnStatuses.includes(r.status) && !isCriticalFailure(r);
  if (!blocking) return;
  if (check.waivedKeys.has(key)) check.add("warn", "WAIVED", `${r.status} waived by approved exception`, key);
  else check.add(r.status === "FAIL" ? "red" : "amber", `REQUIRED_${r.status}`, blockingDetail(r), key);
}

function checkRequiredEvidence(check: RequiredCheck, key: string, r: TestResult): void {
  if (r.status === "NOT_APPLICABLE" && !r.failureReason) {
    check.add("amber", "NOT_APPLICABLE_WITHOUT_REASON", "NOT_APPLICABLE must record why", key);
  }
  if (!check.input.policy.requireEvidence || !lacksEvidence(r)) return;
  check.add("amber", "MISSING_EVIDENCE", r.evidenceError ? `evidence write failed: ${r.evidenceError}` : "no evidence recorded", key);
}

function checkRequired(check: RequiredCheck, required: ReadonlySet<string>): void {
  for (const key of [...required].sort()) {
    const r = check.byKey.get(key);
    if (!r) {
      check.add(check.waivedKeys.has(key) ? "warn" : "amber", "MISSING_RESULT", "required test has no result", key);
      continue;
    }
    checkRequiredStatus(check, key, r);
    checkRequiredEvidence(check, key, r);
  }
}

function checkOptional(required: ReadonlySet<string>, byKey: ResultIndex, input: GateInput, add: AddReason): void {
  const level = input.policy.optionalFailures === "block" ? "red" : "warn";
  const isOptionalFailure = (key: string, r: TestResult): boolean => !required.has(key) && r.status === "FAIL" && !isCriticalCategory(r.category);
  for (const [key, r] of byKey) {
    if (isOptionalFailure(key, r)) add(level, "OPTIONAL_FAILED", r.failureReason ?? "optional test failed", key);
  }
}

function checkSourceApproval(input: GateInput, add: AddReason): void {
  if (!input.policy.requireSourceApproval || input.sources.approved) return;
  const detail = input.sources.issues.length > 0 ? input.sources.issues.join("; ") : "sources are not approved";
  add("amber", "SOURCES_NOT_APPROVED", detail);
}

function checkCleanup(input: GateInput, add: AddReason): void {
  if (!input.policy.requireCleanupSuccess) return;
  const teardown = input.lifecycleFailures.filter((e) => e.phase === "cleanup" || e.phase === "dispose");
  for (const f of teardown) {
    add("amber", "CLEANUP_FAILED", `${f.phase} of '${f.ref}' failed: ${f.error ?? "unknown error"} (leftover test data must be removed)`);
  }
}

function checkLanes(input: GateInput, byKey: ResultIndex, add: AddReason): void {
  const required = Object.entries(input.policy.lanes).filter(([, rule]) => rule.required);
  for (const [lane, rule] of required) {
    const count = [...byKey.values()].filter((r) => r.lane === lane).length;
    if (count < rule.minTests) {
      add("amber", "LANE_MISSING_RESULTS", `lane '${lane}' has ${count} result(s), policy requires at least ${rule.minTests}`);
    }
  }
  for (const file of input.missingLaneReports) add("warn", "LANE_REPORT_MISSING", `lane report not found: ${file}`);
}

function verdictOf(reasons: readonly GateReason[]): Verdict {
  if (reasons.some((r) => r.level === "red")) return "RED";
  return reasons.some((r) => r.level === "amber") ? "AMBER" : "GREEN";
}

/**
 * Deterministic GO/NO-GO over results, evidence metadata, approvals and policy.
 * GO requires every mandatory condition; anything unknown, missing, duplicated
 * or stale blocks. No LLM output is an input here.
 */
export function evaluateGate(input: GateInput): ReleaseGateResult {
  const reasons: GateReason[] = [];
  const add: AddReason = (level, code, message, key) => {
    reasons.push({ level, code, message, ...(key !== undefined && { testKey: key }) });
  };

  const { byKey, counts } = indexResults(input.results, add);
  if (input.policy.requireResultsForCommit && !sameCommit(input.resultsCommitSha, input.commitSha)) {
    add("amber", "STALE_RESULTS", `results were produced for ${input.resultsCommitSha}, gate evaluates ${input.commitSha}`);
  }
  const waived = activeExceptions(input, add);
  checkCritical(byKey, input, add);
  const required = requiredKeys(input, byKey);
  checkRequired({ input, add, byKey, waivedKeys: new Set(waived.map((w) => w.testKey)) }, required);
  checkOptional(required, byKey, input, add);
  checkSourceApproval(input, add);
  checkCleanup(input, add);
  checkLanes(input, byKey, add);
  checkRoute(input, add);
  checkManualE2E(input, add);
  checkTraceability(input, byKey, add);

  const verdict = verdictOf(reasons);
  return {
    decision: verdict === "GREEN" ? "GO" : "NO_GO",
    verdict,
    reasons,
    waived,
    counts,
    policyVersion: input.policy.policyVersion,
    commitSha: input.commitSha,
    evaluatedAt: input.now.toISOString(),
  };
}

// Diagram 1 main gate: intake accepted, cost/value GO, manual E2E PASS, traceable automation.

function checkRoute(input: GateInput, add: AddReason): void {
  const rules = input.policy.lifecycle;
  const route = input.route;
  if (route) {
    checkRouteDecisions(route, rules, add);
  } else if (rules.requireIntakeAccepted || rules.requireCostValueGo) {
    add("amber", "ROUTE_MISSING", "no QA route record (qa-route.yaml): intake and cost/value decisions are unknown");
  }
}

function checkRouteDecisions(route: RouteRecord, rules: ReleasePolicy["lifecycle"], add: AddReason): void {
  if (rules.requireIntakeAccepted && route.intake.status !== "ACCEPTED") add("amber", "INTAKE_NOT_ACCEPTED", `intake is ${route.intake.status}`);
  if (rules.requireCostValueGo && route.costValue.decision !== "GO") add("amber", "COST_VALUE_NOT_GO", `cost/value decision is ${route.costValue.decision}`);
}

function latestManualResults(results: readonly ManualResult[]): Map<string, ManualResult> {
  const latest = new Map<string, ManualResult>();
  const isNewer = (r: ManualResult, prev: ManualResult | undefined): boolean => !prev || Date.parse(r.executedAt) >= Date.parse(prev.executedAt);
  for (const r of results) {
    if (isNewer(r, latest.get(r.tcId))) latest.set(r.tcId, r);
  }
  return latest;
}

const MANUAL_PROBLEMS: Partial<Record<ManualResult["status"], { level: GateReason["level"]; code: string; text: string }>> = {
  FAIL: { level: "red", code: "MANUAL_E2E_FAILED", text: "failed" },
  BLOCKED: { level: "amber", code: "MANUAL_E2E_BLOCKED", text: "is blocked" },
};

function checkManualCase(tc: TestCase, r: ManualResult | undefined, commitSha: string, add: AddReason): void {
  if (!r || r.status === "NOT_RUN") {
    add("amber", "MANUAL_E2E_NOT_RUN", `${tc.id} (${tc.title}) has no manual result`);
    return;
  }
  const problem = MANUAL_PROBLEMS[r.status];
  if (problem) add(problem.level, problem.code, `${tc.id} ${problem.text} (tester: ${r.tester})`);
  else if (r.commitSha && !sameCommit(r.commitSha, commitSha)) {
    add("warn", "MANUAL_E2E_OTHER_COMMIT", `${tc.id} passed on ${r.commitSha}, not on ${commitSha}`);
  }
}

function checkManualE2E(input: GateInput, add: AddReason): void {
  if (!input.policy.lifecycle.requireManualE2EPass) return;
  const latest = latestManualResults(input.manual.results);
  const required = input.manual.cases.filter((c) => c.required && c.type === "manual-e2e");
  for (const tc of required) checkManualCase(tc, latest.get(tc.id), input.commitSha, add);
}

function checkLinkedTest(tc: TestCase, key: string, r: TestResult | undefined, add: AddReason): void {
  if (!r) add("amber", "TRACEABILITY_GAP", `${tc.id} links ${key}, which produced no result`);
  else if (r.status === "FAIL") add("red", "LINKED_TEST_FAILED", `${tc.id} → ${key} failed`, key);
  else if (r.status !== "PASS") add("amber", "LINKED_TEST_NOT_PASSED", `${tc.id} → ${key} is ${r.status}`, key);
}

function checkTraceability(input: GateInput, byKey: ResultIndex, add: AddReason): void {
  const automated = input.manual.cases.filter((c) => c.required && c.type === "automated");
  for (const tc of automated) {
    if (tc.automation.length === 0) add("amber", "TRACEABILITY_GAP", `${tc.id} is 'automated' but links no automated test`);
    for (const key of tc.automation) checkLinkedTest(tc, key, byKey.get(key), add);
  }
}
