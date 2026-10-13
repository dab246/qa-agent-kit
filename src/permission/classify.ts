import { deepEqual, getPath } from "../core/json-path.js";
import type { OperationResponse } from "../core/interfaces.js";
import type { ExpectedOutcome, ResponseAssertion, ResultCategory, Severity } from "../core/schemas.js";

export interface AssertionOutcome {
  assertion: ResponseAssertion;
  passed: boolean;
}

export interface Classification {
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  category?: ResultCategory;
  reason?: string;
  assertions: AssertionOutcome[];
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const statusesOf = (expected: Extract<ExpectedOutcome, { kind: "http" }>): number[] =>
  Array.isArray(expected.status) ? expected.status : [expected.status];

export function expectsDenial(expected: ExpectedOutcome): boolean {
  return expected.kind === "error" || statusesOf(expected).every((s) => s >= 400);
}

function evaluateAssertions(assertions: readonly ResponseAssertion[], body: unknown): AssertionOutcome[] {
  return assertions.map((assertion) => {
    const hit = getPath(body, assertion.path);
    switch (assertion.kind) {
      case "json-exists":
        return { assertion, passed: hit.found };
      case "json-not-exists":
        return { assertion, passed: !hit.found };
      case "json-equals":
        return { assertion, passed: hit.found && deepEqual(hit.value, assertion.expected) };
    }
  });
}

function fail(category: ResultCategory, reason: string): Classification {
  return { status: "FAIL", category, reason, assertions: [] };
}

function statusCategory(denial: boolean, status: number): ResultCategory {
  if (denial && isSuccess(status)) return "PRIVILEGE_ESCALATION";
  return !denial && status >= 400 ? "UNEXPECTED_DENIAL" : "STATUS_MISMATCH";
}

/** Status or error-code mismatch; undefined when the response has the expected shape. */
function outcomeMismatch(expected: ExpectedOutcome, response: OperationResponse): Classification | undefined {
  if (expected.kind === "http") {
    const allowed = statusesOf(expected);
    if (allowed.includes(response.status)) return undefined;
    return fail(statusCategory(expectsDenial(expected), response.status), `expected HTTP ${allowed.join("|")}, got ${response.status}`);
  }
  if (response.errorCode === undefined && isSuccess(response.status)) {
    return fail("PRIVILEGE_ESCALATION", `expected error ${expected.code}, operation succeeded (HTTP ${response.status})`);
  }
  if (response.errorCode === expected.code) return undefined;
  return fail("ERROR_CODE_MISMATCH", `expected error ${expected.code}, got ${response.errorCode ?? `none (HTTP ${response.status})`}`);
}

function assertionVerdict(expected: ExpectedOutcome, response: OperationResponse): Classification {
  if (expected.assertions.length > 0 && response.bodyComplete === false) {
    // A truncated denial body could hide exactly the field `json-not-exists` guards against.
    const reason = "response body is truncated or unparseable; assertions cannot be evaluated";
    return { status: "INCONCLUSIVE", category: "BODY_INCOMPLETE", reason, assertions: [] };
  }
  const assertions = evaluateAssertions(expected.assertions, response.body);
  const failed = assertions.filter((a) => !a.passed);
  if (failed.length === 0) return { status: "PASS", assertions };
  const leaked = expectsDenial(expected) && failed.some((a) => a.assertion.kind === "json-not-exists");
  const reason = failed.map((a) => `${a.assertion.kind} ${a.assertion.path} failed`).join("; ");
  return { status: "FAIL", category: leaked ? "DATA_DISCLOSURE" : "ASSERTION_FAILED", reason, assertions };
}

/**
 * Pure comparison of an observed response with the approved expectation.
 * A 200 is only a violation relative to an expected denial; a 403 is only safe
 * if the denial body does not leak what the assertions protect.
 */
export function classifyResponse(expected: ExpectedOutcome, response: OperationResponse): Classification {
  return outcomeMismatch(expected, response) ?? assertionVerdict(expected, response);
}

const CRITICAL: ReadonlySet<ResultCategory> = new Set(["PRIVILEGE_ESCALATION", "DATA_DISCLOSURE"]);

export function isCriticalCategory(category: ResultCategory | undefined): boolean {
  return category !== undefined && CRITICAL.has(category);
}

export function severityFor(category: ResultCategory | undefined, declared: Severity): Severity {
  return isCriticalCategory(category) ? "critical" : declared;
}
