import { ValidationError } from "../core/errors.js";
import { loadFile } from "../core/files.js";
import { PermissionMatrixSchema, type PermissionMatrix, type PermissionProbe } from "../core/schemas.js";

export interface MatrixCatalog {
  /** Operation ids the target allowlists. */
  operations: { has(id: string): boolean };
  /** Fixture ids the target can seed. */
  fixtures: { has(id: string): boolean };
  /** Role each target actor is provisioned with. */
  roleOf(actorRef: string): string | undefined;
}

export async function loadMatrix(path: string): Promise<PermissionMatrix> {
  return loadFile(PermissionMatrixSchema, path);
}

function actorIssues(matrix: PermissionMatrix, catalog: MatrixCatalog): string[] {
  const issues: string[] = [];
  const declared = new Set<string>();
  for (const actor of matrix.actors) {
    if (declared.has(actor.ref)) issues.push(`actor '${actor.ref}' is declared twice`);
    declared.add(actor.ref);
    const provisioned = catalog.roleOf(actor.ref);
    if (provisioned === undefined) issues.push(`actor '${actor.ref}' is not provisioned by the target`);
    // Running a "regular-user" probe as an admin would turn every denial into a false finding.
    else if (provisioned !== actor.role) issues.push(`actor '${actor.ref}' has role '${provisioned}' in the target, matrix expects '${actor.role}'`);
  }
  return issues;
}

function probeIssues(probe: PermissionProbe, actors: ReadonlySet<string>, catalog: MatrixCatalog): string[] {
  const issues: string[] = [];
  if (!actors.has(probe.actorRef)) issues.push(`probe '${probe.id}': unknown actorRef '${probe.actorRef}'`);
  if (!catalog.operations.has(probe.operationId)) {
    issues.push(`probe '${probe.id}': operation '${probe.operationId}' is not in the operation registry`);
  }
  const unknownFixtures = probe.fixtureRefs.filter((f) => !catalog.fixtures.has(f));
  return [...issues, ...unknownFixtures.map((f) => `probe '${probe.id}': unknown fixture '${f}'`)];
}

/**
 * Semantic checks that the schema cannot express. Any issue rejects the whole
 * matrix before a single probe runs (AT-06, AT-07, AT-13).
 */
export function matrixIssues(matrix: PermissionMatrix, catalog: MatrixCatalog): string[] {
  const issues = actorIssues(matrix, catalog);
  const actors = new Set(matrix.actors.map((a) => a.ref));
  const seen = new Set<string>();
  for (const probe of matrix.probes) {
    if (seen.has(probe.id)) issues.push(`probe id '${probe.id}' is duplicated`);
    seen.add(probe.id);
    issues.push(...probeIssues(probe, actors, catalog));
  }
  return issues;
}

export function assertMatrixValid(matrix: PermissionMatrix, catalog: MatrixCatalog): void {
  const issues = matrixIssues(matrix, catalog);
  if (issues.length > 0) throw new ValidationError(`matrix '${matrix.matrixId}' is invalid`, issues);
}

export function assertUniqueMatrixIds(matrices: readonly PermissionMatrix[]): void {
  const seen = new Set<string>();
  const dupes = matrices.filter((m) => (seen.has(m.matrixId) ? true : (seen.add(m.matrixId), false)));
  if (dupes.length > 0) {
    throw new ValidationError("duplicate matrix ids", dupes.map((m) => m.matrixId));
  }
}
