import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../core/files.js";
import type { PermissionMatrix, SourceManifest } from "../core/schemas.js";

export interface SourceCheck {
  /** True only when the manifest is APPROVED and every referenced source is verified and unchanged. */
  approved: boolean;
  issues: string[];
  /** Sources whose pinned file content changed: the change loop re-opens Phase 0 for them. */
  changedSources: string[];
}

type Source = SourceManifest["sources"][number];
type SourceUser = Pick<PermissionMatrix, "matrixId" | "sourceRefs">;

/** A pinned source file that is missing or whose content changed since approval. */
async function pinnedFileIssue(source: Source, manifestDir: string): Promise<string | undefined> {
  if (!source.path || !source.sha256) return undefined;
  try {
    const content = await readFile(resolve(manifestDir, source.path));
    return sha256(content) === source.sha256 ? undefined : `source '${source.id}': ${source.path} changed since approval (sha256 mismatch) — re-run Phase 0`;
  } catch {
    return `source '${source.id}': file ${source.path} is missing`;
  }
}

function referenceIssue(matrixId: string, ref: { id: string; revision: string }, source: Source | undefined): string | undefined {
  if (!source) return `matrix '${matrixId}': source '${ref.id}' is not in the manifest`;
  if (source.revision !== ref.revision) {
    return `matrix '${matrixId}': source '${ref.id}' revision '${ref.revision}' ≠ manifest revision '${source.revision}'`;
  }
  return source.status === "VERIFIED" ? undefined : `matrix '${matrixId}': source '${ref.id}' is ${source.status}, not VERIFIED`;
}

function referenceIssues(manifest: SourceManifest, matrices: readonly SourceUser[]): string[] {
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));
  return matrices
    .flatMap((m) => m.sourceRefs.map((ref) => referenceIssue(m.matrixId, ref, byId.get(ref.id))))
    .filter((issue) => issue !== undefined);
}

/**
 * Phase 0: every expectation the engine enforces must trace back to a
 * verified, approved, unchanged source. Nothing here invents an expectation.
 */
export async function checkSources(manifest: SourceManifest, manifestDir: string, matrices: readonly SourceUser[]): Promise<SourceCheck> {
  const approval = manifest.approval.status === "APPROVED" ? [] : [`source manifest '${manifest.manifestId}' is ${manifest.approval.status}, not APPROVED`];
  const pinned = await Promise.all(manifest.sources.map(async (s) => ({ id: s.id, issue: await pinnedFileIssue(s, manifestDir) })));
  const changed = pinned.flatMap((p) => (p.issue === undefined ? [] : [{ id: p.id, issue: p.issue }]));
  const assumptions = manifest.assumptions.filter((a) => !a.resolved).map((a) => `assumption '${a.id}' is unresolved: ${a.statement}`);
  const issues = [...approval, ...changed.map((p) => p.issue), ...referenceIssues(manifest, matrices), ...assumptions];
  return { approved: issues.length === 0, issues, changedSources: changed.map((p) => p.id) };
}

/** Re-pins file hashes after a source change and drops approval back to PENDING for re-review. */
export async function rehashSources(manifest: SourceManifest, manifestDir: string): Promise<{ manifest: SourceManifest; changed: string[] }> {
  const changed: string[] = [];
  const sources = await Promise.all(
    manifest.sources.map(async (source) => {
      if (!source.path) return source;
      const digest = sha256(await readFile(resolve(manifestDir, source.path)));
      if (digest === source.sha256) return source;
      changed.push(source.id);
      return { ...source, sha256: digest, status: "UNVERIFIED" as const };
    }),
  );
  if (changed.length === 0) return { manifest, changed };
  return { manifest: { ...manifest, sources, approval: { status: "PENDING" } }, changed };
}
