import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProjectConfigSchema, type ProjectConfig } from "../config/schema.js";
import { ValidationError } from "../core/errors.js";
import { loadFile } from "../core/files.js";
import {
  ManualResultsSchema,
  ReleasePolicySchema,
  RouteRecordSchema,
  SourceManifestSchema,
  type ManualResult,
  type PermissionMatrix,
  type ReleasePolicy,
  type RouteRecord,
  type SourceManifest,
} from "../core/schemas.js";
import { loadTestPacks, type TestCase } from "../lifecycle/test-pack.js";
import { assertUniqueMatrixIds, loadMatrix } from "../permission/matrix.js";

export interface LoadedProject {
  config: ProjectConfig;
  configPath: string;
  /** Directory every relative path in the config resolves against. */
  dir: string;
  policy: ReleasePolicy;
  manifest: SourceManifest;
  manifestPath: string;
  route: RouteRecord | undefined;
  matrices: PermissionMatrix[];
  testCases: TestCase[];
  manualResults: ManualResult[];
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Collects validation issues so a broken setup is reported in one pass, not one error at a time. */
class Issues {
  readonly list: string[] = [];

  async attempt<T>(load: () => Promise<T>): Promise<T | undefined> {
    try {
      return await load();
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      this.list.push(error.message);
      return undefined;
    }
  }

  /** Loads an optional file: absent is fine (the gate reports what is missing), invalid is not. */
  async optional<T>(path: string | undefined, load: (path: string) => Promise<T>): Promise<T | undefined> {
    if (path === undefined || !(await exists(path))) return undefined;
    return this.attempt(() => load(path));
  }
}

function assertEnvironmentAllowed(config: ProjectConfig): void {
  if (config.safety.allowedEnvironments.includes(config.project.environment)) return;
  throw new ValidationError("environment is not allowlisted", [
    `project.environment '${config.project.environment}' is not in safety.allowedEnvironments (${config.safety.allowedEnvironments.join(", ")})`,
  ]);
}

function routePathIssues(config: ProjectConfig, route: RouteRecord | undefined): string[] {
  const paths = Object.keys(config.routing.paths);
  // No route yet, or no path catalogue to check against.
  if (!route || paths.length === 0) return [];
  return paths.includes(route.path) ? [] : [`route path '${route.path}' is not one of routing.paths (${paths.join(", ")})`];
}

async function loadMatrices(files: readonly string[], issues: Issues): Promise<PermissionMatrix[]> {
  const matrices: PermissionMatrix[] = [];
  for (const file of files) {
    const matrix = await issues.attempt(() => loadMatrix(file));
    if (matrix) matrices.push(matrix);
  }
  await issues.attempt(async () => assertUniqueMatrixIds(matrices));
  return matrices;
}

function orphanResultIssues(results: readonly ManualResult[], cases: readonly TestCase[]): string[] {
  const known = new Set(cases.map((c) => c.id));
  return results.filter((r) => !known.has(r.tcId)).map((r) => `manual result for '${r.tcId}', which no test pack defines`);
}

/** Policy and manifest are mandatory: without them nothing can be gated. */
async function loadCore(
  config: ProjectConfig,
  dir: string,
  issues: Issues,
): Promise<Pick<LoadedProject, "policy" | "manifest" | "manifestPath"> | undefined> {
  const manifestPath = resolve(dir, config.sources.manifest);
  const policy = await issues.attempt(() => loadFile(ReleasePolicySchema, resolve(dir, config.releaseGate.policy)));
  const manifest = await issues.attempt(() => loadFile(SourceManifestSchema, manifestPath));
  return policy && manifest ? { policy, manifest, manifestPath } : undefined;
}

const resolveOptional = (dir: string, path: string | undefined): string | undefined => (path === undefined ? undefined : resolve(dir, path));

/**
 * Loads and validates every input of a run. Any problem is a ValidationError
 * raised before a single probe executes (AT-12).
 */
export async function loadProject(configPath: string): Promise<LoadedProject> {
  const absConfig = resolve(configPath);
  const config = await loadFile(ProjectConfigSchema, absConfig);
  assertEnvironmentAllowed(config);
  const dir = dirname(absConfig);
  const at = (p: string): string => resolve(dir, p);
  const issues = new Issues();

  const core = await loadCore(config, dir, issues);
  const route = await issues.optional(resolveOptional(dir, config.routing.route), (p) => loadFile(RouteRecordSchema, p));
  const matrices = await loadMatrices(config.permission?.matrices.map(at) ?? [], issues);
  const testCases = (await issues.attempt(() => loadTestPacks(config.testPacks.files.map(at)))) ?? [];
  const manual = await issues.optional(resolveOptional(dir, config.testPacks.manualResults), (p) => loadFile(ManualResultsSchema, p));
  const manualResults = manual?.results ?? [];
  issues.list.push(...routePathIssues(config, route), ...orphanResultIssues(manualResults, testCases));

  if (!core || issues.list.length > 0) throw new ValidationError(`project ${configPath} is invalid`, issues.list);
  return { config, configPath: absConfig, dir, ...core, route, matrices, testCases, manualResults };
}
