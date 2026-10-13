import { globMatch } from "../core/glob.js";
import type { ProjectConfig } from "../config/schema.js";

export interface ImpactSelection {
  /** Matrix ids to run. */
  matrices: string[];
  /** Lanes the change touches (informational for the route; required lanes come from policy). */
  lanes: string[];
  mode: "all" | "selected";
  reasons: string[];
  unmatchedFiles: string[];
}

/**
 * Change-impact loop: map changed files to matrices. When impact is unknown
 * (no file list, or a file no rule claims) the safe answer is to run everything.
 */
export function selectByImpact(
  impact: ProjectConfig["impact"],
  allMatrices: readonly string[],
  changedFiles: readonly string[] | undefined,
): ImpactSelection {
  const all = (reason: string, unmatchedFiles: string[] = []): ImpactSelection => ({
    matrices: [...allMatrices],
    lanes: [],
    mode: "all",
    reasons: [reason],
    unmatchedFiles,
  });
  if (changedFiles === undefined) return all("no changed-file list: running every matrix");
  if (impact.rules.length === 0) return all("no impact rules configured: running every matrix");

  const matrices = new Set(impact.alwaysRun.filter((m) => allMatrices.includes(m)));
  const lanes = new Set<string>();
  const reasons: string[] = impact.alwaysRun.length > 0 ? [`always run: ${impact.alwaysRun.join(", ")}`] : [];
  const unmatched: string[] = [];
  for (const file of changedFiles) {
    const rules = impact.rules.filter((rule) => rule.paths.some((p) => globMatch(p, file)));
    if (rules.length === 0) {
      unmatched.push(file);
      continue;
    }
    for (const rule of rules) {
      rule.matrices.forEach((m) => matrices.add(m));
      rule.lanes.forEach((l) => lanes.add(l));
    }
  }
  if (unmatched.length > 0 && impact.onUnmatched === "run-all") {
    return all(`${unmatched.length} changed file(s) match no impact rule: running every matrix`, unmatched);
  }
  const unknown = [...matrices].filter((m) => !allMatrices.includes(m));
  if (unknown.length > 0) return all(`impact rules reference unknown matrices (${unknown.join(", ")}): running every matrix`);
  reasons.push(`${changedFiles.length} changed file(s) mapped to ${matrices.size} matrix(es)`);
  return { matrices: [...matrices].sort(), lanes: [...lanes].sort(), mode: "selected", reasons, unmatchedFiles: unmatched };
}
