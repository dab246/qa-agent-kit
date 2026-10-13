import { testKey, type TestResult } from "../core/schemas.js";
import type { ReleaseGateResult } from "../release-gate/gate.js";
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

export interface MarkdownOptions {
  /** Short form for PR comments / step summaries: gate and failures only. */
  compact?: boolean;
  /** Link prefix for evidence references (e.g. a CI artifact URL); plain paths when absent. */
  evidenceBaseUrl?: string;
}

export function renderMarkdown(record: RunRecord, gate: ReleaseGateResult, options: MarkdownOptions = {}): string {
  const lines: string[] = [];
  const pr = record.pullRequest;
  lines.push(
    `# QA release gate: ${VERDICT_ICON[gate.verdict]} ${gate.decision} (${gate.verdict})`,
    "",
    "| | |",
    "| --- | --- |",
    `| Project | \`${md(record.project.id)}\` · env \`${md(record.project.environment)}\` |`,
    `| Commit | \`${md(record.commitSha, 64)}\` |`,
    ...(pr ? [`| Source | ${[md(pr.provider), md(pr.id), pr.title && `— ${md(pr.title, 120)}`].filter(Boolean).join(" ")} |`] : []),
    `| Run | \`${md(record.runId)}\` · kit ${md(record.kitVersion)} · policy ${md(gate.policyVersion)} |`,
    `| Plan | ${record.plan.mode === "all" ? "all matrices" : `selected: ${record.plan.matrices.map((m) => `\`${md(m)}\``).join(", ")}`} |`,
    `| Results | ${Object.entries(gate.counts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${s} ${n}`)
      .join(" · ") || "none"} |`,
    "",
  );

  const blocking = gate.reasons.filter((r) => r.level !== "warn");
  const warnings = gate.reasons.filter((r) => r.level === "warn");
  if (blocking.length > 0) {
    lines.push("## Blocking reasons", "", "| | Code | Test | Detail |", "| --- | --- | --- | --- |");
    for (const r of blocking) {
      lines.push(`| ${LEVEL_ICON[r.level]} | ${r.code} | ${r.testKey ? `\`${md(r.testKey, 120)}\`` : ""} | ${md(r.message)} |`);
    }
    lines.push("");
  } else {
    lines.push("All mandatory gate conditions are satisfied.", "");
  }
  if (warnings.length > 0) {
    lines.push("## Warnings (non-blocking)", "");
    for (const w of warnings) lines.push(`- ${w.code}${w.testKey ? ` \`${md(w.testKey, 120)}\`` : ""}: ${md(w.message)}`);
    lines.push("");
  }
  if (gate.waived.length > 0) {
    lines.push("## Approved exceptions", "");
    for (const w of gate.waived) {
      lines.push(`- \`${md(w.testKey, 120)}\` by ${md(w.approvedBy, 80)} until ${md(w.expiresAt, 40)}: ${md(w.reason)}`);
    }
    lines.push("");
  }

  if (options.compact) {
    lines.push("_Full report, evidence and JUnit XML are in the run artifacts._", "");
    return lines.join("\n");
  }

  lines.push(...actorMatrix(record.results));

  const bySuite = new Map<string, TestResult[]>();
  for (const r of record.results) {
    const key = `${r.lane}:${r.suiteId}`;
    bySuite.set(key, [...(bySuite.get(key) ?? []), r]);
  }
  const evidence = (ref: string): string =>
    options.evidenceBaseUrl ? `[${md(ref, 200)}](${options.evidenceBaseUrl}/${encodeURI(ref)})` : `\`${md(ref, 200)}\``;
  for (const [suite, items] of bySuite) {
    lines.push(
      `## ${md(suite, 120)}`,
      "",
      "| Test | Req | Actor (role) | Operation | Expected | Actual | Status | Detail | Evidence |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const r of items) {
      lines.push(
        [
          "",
          `\`${md(r.testId, 120)}\``,
          r.required ? "yes" : "no",
          r.actorRef ? `${md(r.actorRef, 60)} (${md(r.role ?? "?", 60)})` : "—",
          r.operationId ? `\`${md(r.operationId, 80)}\`` : "—",
          expectedText(r),
          actualText(r),
          `**${r.status}**${r.category ? ` ${r.category}` : ""}`,
          md(r.evidenceError ? `evidence error: ${r.evidenceError}` : r.failureReason, 200),
          r.evidenceRefs.map(evidence).join("<br>") || "—",
          "",
        ].join(" | ").trim(),
      );
    }
    lines.push("");
  }

  const lifecycleFailures = record.lifecycle.filter((e) => !e.ok);
  if (lifecycleFailures.length > 0) {
    lines.push("## Setup and teardown failures", "");
    for (const e of lifecycleFailures) {
      lines.push(`- ${e.phase} \`${md(e.ref, 80)}\` (matrix \`${md(e.matrixId, 80)}\`): ${md(e.error)}`);
    }
    lines.push("");
  }

  lines.push(
    "## Sources (Phase 0)",
    "",
    `Manifest \`${md(record.sources.manifestId)}\`: ${record.sources.approved ? "approved and unchanged" : "**not approved**"}`,
    "",
  );
  for (const issue of record.sources.issues) lines.push(`- ${md(issue)}`);
  if (record.sources.issues.length > 0) lines.push("");
  for (const m of record.matrices) {
    lines.push(`- matrix \`${md(m.matrixId)}\` v${m.version} ← ${m.sourceRefs.map((s) => `${md(s.id)}@${md(s.revision, 60)}`).join(", ")}`);
  }
  lines.push("");

  if (record.route) {
    const r = record.route;
    lines.push(
      "## Route (S0)",
      "",
      `Path ${md(r.path)} · owner ${md(r.owner)} · risk ${r.risk} · lanes ${r.lanes.map((l) => md(l)).join(", ")}`,
      "",
      `- Intake: ${r.intake.status}${r.intake.decidedBy ? ` (${md(r.intake.decidedBy)})` : ""}`,
      `- Cost/value: ${r.costValue.decision}${r.costValue.decidedBy ? ` (${md(r.costValue.decidedBy)})` : ""}`,
      ...r.gaps.map((g) => `- Gap: ${md(g)}`),
      "",
    );
  }

  const manualCases = record.manual.cases.filter((c) => c.type === "manual-e2e");
  if (manualCases.length > 0) {
    const latest = new Map(record.manual.results.map((r) => [r.tcId, r]));
    lines.push("## Manual E2E (Phase 1)", "", "| Test case | Required | Result | Tester |", "| --- | --- | --- | --- |");
    for (const tc of manualCases) {
      const r = latest.get(tc.id);
      lines.push(`| \`${md(tc.id)}\` ${md(tc.title, 80)} | ${tc.required ? "yes" : "no"} | ${r?.status ?? "NOT_RUN"} | ${md(r?.tester ?? "—", 60)} |`);
    }
    lines.push("");
  }

  const requiredMissing = record.plan.requiredKeys.filter((k) => !record.results.some((r) => testKey(r) === k));
  if (requiredMissing.length > 0) {
    lines.push("## Planned but not executed", "", ...requiredMissing.map((k) => `- \`${md(k, 120)}\``), "");
  }

  lines.push(
    "---",
    "",
    `Generated ${md(gate.evaluatedAt)} by qa-agent-kit ${md(record.kitVersion)}. PASS/FAIL and the gate decision come from the deterministic engine and policy only.`,
    "",
  );
  return lines.join("\n");
}
