import { testKey, type TestResult } from "../core/schemas.js";
import { latestManualResults, type ReleaseGateResult } from "../release-gate/gate.js";
import { PERMISSION_LANE } from "../permission/driver.js";
import { expectsDenial } from "../permission/classify.js";
import type { RunRecord } from "./run-record.js";
import { md } from "./escape.js";

/** Diagram 2 outcome labels, derived from the canonical status; never used for gating. */
export function diagramLabel(r: TestResult): string {
  if (r.status === "PASS") return r.expected && expectsDenial(r.expected) ? "V1 pass" : "ALLOW";
  if (r.status === "FAIL") return r.category === "PRIVILEGE_ESCALATION" ? "V2 violation" : `FAIL`;
  if (r.status === "INCONCLUSIVE") return r.category === "NO_EXPECTATION" ? "SKIP" : "V3 inconclusive";
  return r.status;
}

const VERDICT_ICON = { GREEN: "🟢", AMBER: "🟠", RED: "🔴" } as const;
const LEVEL_ICON = { red: "🔴", amber: "🟠", warn: "⚪" } as const;

function expectedText(r: TestResult): string {
  if (!r.expected) return "—";
  if (r.expected.kind === "error") return `error ${r.expected.code}`;
  const s = r.expected.status;
  return `HTTP ${Array.isArray(s) ? s.join("\\|") : s}`;
}

function actualText(r: TestResult): string {
  if (!r.actual) return "—";
  return [r.actual.httpStatus !== undefined && `HTTP ${r.actual.httpStatus}`, r.actual.errorCode && md(r.actual.errorCode, 60)]
    .filter(Boolean)
    .join(" / ");
}

/** Operation × actor grid, the "main-flow actor matrix" of diagram 2. Two actors may share a role. */
function actorMatrix(results: readonly TestResult[]): string[] {
  const perm = results.filter((r) => r.lane === PERMISSION_LANE && r.operationId && r.actorRef);
  if (perm.length === 0) return [];
  const actors = [...new Map(perm.map((r) => [r.actorRef!, r.role ?? "?"])).entries()].sort(([a], [b]) => a.localeCompare(b));
  const ops = [...new Set(perm.map((r) => r.operationId!))].sort();
  const cell = new Map<string, string[]>();
  for (const r of perm) {
    const k = `${r.operationId}\u0000${r.actorRef}`;
    cell.set(k, [...(cell.get(k) ?? []), diagramLabel(r)]);
  }
  const lines = [
    "## Actor matrix",
    "",
    `| Operation | ${actors.map(([ref, role]) => (ref === role ? md(ref, 40) : `${md(ref, 40)} (${md(role, 40)})`)).join(" | ")} |`,
    `| --- | ${actors.map(() => "---").join(" | ")} |`,
  ];
  for (const op of ops) {
    const cells = actors.map(([ref]) => (cell.get(`${op}\u0000${ref}`) ?? ["·"]).join(", "));
    lines.push(`| \`${md(op, 80)}\` | ${cells.join(" | ")} |`);
  }
  lines.push(
    "",
    "V1 = denied as expected · ALLOW = allowed as expected · V2 = privilege escalation · V3 = inconclusive · SKIP = no approved expectation",
    "",
  );
  return lines;
}

function planText(record: RunRecord): string {
  if (record.matrices.length === 0) return "no permission matrices; lanes and lifecycle only";
  const selected = record.plan.matrices.map((m) => `\`${md(m)}\``).join(", ");
  return record.plan.mode === "all" ? "all matrices" : `selected: ${selected || "none"}`;
}

export interface MarkdownOptions {
  /** Short form for PR comments / step summaries: gate and failures only. */
  compact?: boolean;
  /** Link prefix for evidence references (e.g. a CI artifact URL); plain paths when absent. */
  evidenceBaseUrl?: string;
}

const code = (text: string | undefined, max = 120): string => (text ? `\`${md(text, max)}\`` : "");
const by = (who: string | undefined): string => (who ? ` (${md(who)})` : "");

function headerSection(record: RunRecord, gate: ReleaseGateResult): string[] {
  const pr = record.pullRequest;
  const counts = Object.entries(gate.counts).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`);
  const source = pr && [md(pr.provider), md(pr.id), pr.title && `— ${md(pr.title, 120)}`].filter(Boolean).join(" ");
  return [
    `# QA release gate: ${VERDICT_ICON[gate.verdict]} ${gate.decision} (${gate.verdict})`,
    "",
    "| | |",
    "| --- | --- |",
    `| Project | ${code(record.project.id)} · env ${code(record.project.environment)} |`,
    `| Commit | ${code(record.commitSha, 64)} |`,
    ...(source ? [`| Source | ${source} |`] : []),
    `| Run | ${code(record.runId)} · kit ${md(record.kitVersion)} · policy ${md(gate.policyVersion)} |`,
    `| Plan | ${planText(record)} |`,
    `| Results | ${counts.join(" · ") || "none"} |`,
    "",
  ];
}

function reasonsSection(gate: ReleaseGateResult): string[] {
  const blocking = gate.reasons.filter((r) => r.level !== "warn");
  if (blocking.length === 0) return ["All mandatory gate conditions are satisfied.", ""];
  const rows = blocking.map((r) => `| ${LEVEL_ICON[r.level]} | ${r.code} | ${code(r.testKey)} | ${md(r.message)} |`);
  return ["## Blocking reasons", "", "| | Code | Test | Detail |", "| --- | --- | --- | --- |", ...rows, ""];
}

/** A titled bullet list, or nothing when there are no items. */
function listSection(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`## ${title}`, "", ...items.map((i) => `- ${i}`), ""];
}

function warningsSection(gate: ReleaseGateResult): string[] {
  const warnings = gate.reasons.filter((r) => r.level === "warn");
  const items = warnings.map((w) => `${w.code}${w.testKey ? ` ${code(w.testKey)}` : ""}: ${md(w.message)}`);
  const waivers = gate.waived.map((w) => `${code(w.testKey)} by ${md(w.approvedBy, 80)} until ${md(w.expiresAt, 40)}: ${md(w.reason)}`);
  return [...listSection("Warnings (non-blocking)", items), ...listSection("Approved exceptions", waivers)];
}

function groupBySuite(results: readonly TestResult[]): Map<string, TestResult[]> {
  const bySuite = new Map<string, TestResult[]>();
  for (const r of results) {
    const key = `${r.lane}:${r.suiteId}`;
    bySuite.set(key, [...(bySuite.get(key) ?? []), r]);
  }
  return bySuite;
}

function resultRow(r: TestResult, evidence: (ref: string) => string): string {
  const cells = [
    code(r.testId),
    r.required ? "yes" : "no",
    r.actorRef ? `${md(r.actorRef, 60)} (${md(r.role ?? "?", 60)})` : "—",
    code(r.operationId, 80) || "—",
    expectedText(r),
    actualText(r),
    `**${r.status}**${r.category ? ` ${r.category}` : ""}`,
    md(r.evidenceError ? `evidence error: ${r.evidenceError}` : r.failureReason, 200),
    r.evidenceRefs.map(evidence).join("<br>") || "—",
  ];
  return `| ${cells.join(" | ")} |`;
}

function resultsSection(record: RunRecord, options: MarkdownOptions): string[] {
  const evidence = (ref: string): string =>
    options.evidenceBaseUrl ? `[${md(ref, 200)}](${options.evidenceBaseUrl}/${encodeURI(ref)})` : code(ref, 200);
  const header = ["| Test | Req | Actor (role) | Operation | Expected | Actual | Status | Detail | Evidence |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  return [...groupBySuite(record.results)].flatMap(([suite, items]) => [
    `## ${md(suite, 120)}`,
    "",
    ...header,
    ...items.map((r) => resultRow(r, evidence)),
    "",
  ]);
}

function sourcesSection(record: RunRecord): string[] {
  const failures = record.lifecycle.filter((e) => !e.ok).map((e) => `${e.phase} ${code(e.ref, 80)} (matrix ${code(e.matrixId, 80)}): ${md(e.error)}`);
  const matrices = record.matrices.map((m) => `- matrix ${code(m.matrixId)} v${m.version} ← ${m.sourceRefs.map((s) => `${md(s.id)}@${md(s.revision, 60)}`).join(", ")}`);
  const status = record.sources.approved ? "approved and unchanged" : "**not approved**";
  return [
    ...listSection("Setup and teardown failures", failures),
    "## Sources (Phase 0)",
    "",
    `Manifest ${code(record.sources.manifestId)}: ${status}`,
    "",
    ...record.sources.issues.map((i) => `- ${md(i)}`),
    ...matrices,
    "",
  ];
}

function routeSection(record: RunRecord): string[] {
  const r = record.route;
  if (!r) return [];
  return [
    "## Route (S0)",
    "",
    `Path ${md(r.path)} · owner ${md(r.owner)} · risk ${r.risk} · lanes ${r.lanes.map((l) => md(l)).join(", ")}`,
    "",
    `- Intake: ${r.intake.status}${by(r.intake.decidedBy)}`,
    `- Cost/value: ${r.costValue.decision}${by(r.costValue.decidedBy)}`,
    ...r.gaps.map((g) => `- Gap: ${md(g)}`),
    "",
  ];
}

function manualSection(record: RunRecord): string[] {
  const cases = record.manual.cases.filter((c) => c.type === "manual-e2e");
  if (cases.length === 0) return [];
  const latest = latestManualResults(record.manual.results);
  const rows = cases.map((tc) => {
    const r = latest.get(tc.id);
    return `| ${code(tc.id)} ${md(tc.title, 80)} | ${tc.required ? "yes" : "no"} | ${r?.status ?? "NOT_RUN"} | ${md(r?.tester ?? "—", 60)} |`;
  });
  return ["## Manual E2E (Phase 1)", "", "| Test case | Required | Result | Tester |", "| --- | --- | --- | --- |", ...rows, ""];
}

function missingSection(record: RunRecord): string[] {
  const executed = new Set(record.results.map(testKey));
  const missing = record.plan.requiredKeys.filter((k) => !executed.has(k)).map((k) => code(k));
  return listSection("Planned but not executed", missing);
}

export function renderMarkdown(record: RunRecord, gate: ReleaseGateResult, options: MarkdownOptions = {}): string {
  const summary = [...headerSection(record, gate), ...reasonsSection(gate), ...warningsSection(gate)];
  if (options.compact) return [...summary, "_Full report, evidence and JUnit XML are in the run artifacts._", ""].join("\n");
  return [
    ...summary,
    ...actorMatrix(record.results),
    ...resultsSection(record, options),
    ...sourcesSection(record),
    ...routeSection(record),
    ...manualSection(record),
    ...missingSection(record),
    "---",
    "",
    `Generated ${md(gate.evaluatedAt)} by qa-agent-kit ${md(record.kitVersion)}. PASS/FAIL and the gate decision come from the deterministic engine and policy only.`,
    "",
  ].join("\n");
}
