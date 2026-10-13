import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PullRequestContext } from "../adapters/ci/ci.js";
import { catalogOf, HttpTarget } from "../adapters/http/http-target.js";
import { HttpTargetSchema } from "../adapters/http/schema.js";
import { ValidationError } from "../core/errors.js";
import { exitCodeForVerdict, type ExitCode } from "../core/exit-codes.js";
import { loadFile, writeJson, writeText } from "../core/files.js";
import type { Target } from "../core/interfaces.js";
import { omitUndefined } from "../core/objects.js";
import { testKey, type PermissionMatrix, type PermissionProbe, type TestResult } from "../core/schemas.js";
import { KIT_VERSION } from "../core/version.js";
import { Redactor } from "../evidence/redact.js";
import { FileEvidenceWriter } from "../evidence/writer.js";
import { ingestJUnit } from "../lanes/junit.js";
import { selectByImpact, type ImpactSelection } from "../lifecycle/impact.js";
import { checkSources } from "../lifecycle/sources.js";
import { PERMISSION_LANE, runMatrix, type LifecycleEvent } from "../permission/driver.js";
import { matrixIssues, type MatrixCatalog } from "../permission/matrix.js";
import { evaluateGate, type ReleaseGateResult } from "../release-gate/gate.js";
import { renderJUnit } from "../reporting/junit.js";
import { renderMarkdown } from "../reporting/markdown.js";
import { RunRecordSchema, type RunRecord } from "../reporting/run-record.js";
import { loadProject, type LoadedProject } from "./project.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface RunOptions {
  configPath: string;
  context: PullRequestContext;
  env: Env;
  runId?: string;
  /** Overrides `evidence.directory`. */
  outDir?: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Test seam: build the target another way (e.g. the in-memory fake). */
  createTarget?: (project: LoadedProject) => Promise<Target>;
}

export interface RunOutcome {
  runDir: string;
  record: RunRecord;
  gate: ReleaseGateResult;
  exitCode: ExitCode;
}

export function newRunId(now: Date, commitSha: string): string {
  const stamp = now.toISOString().replaceAll(":", "").replaceAll("-", "").slice(0, 15);
  return `${stamp}-${commitSha.slice(0, 7)}-${randomBytes(3).toString("hex")}`;
}

async function defaultTarget(project: LoadedProject, env: Env): Promise<Target> {
  const permission = project.config.permission;
  if (!permission) throw new ValidationError("no permission target configured");
  return HttpTarget.fromFile(resolve(project.dir, permission.target), {
    env,
    allowedHosts: project.config.safety.allowedHosts,
  });
}

/** Static matrix check against the declared target: no network, no secrets (used by `validate`). */
export async function staticCatalog(project: LoadedProject): Promise<MatrixCatalog | undefined> {
  const permission = project.config.permission;
  if (!permission) return undefined;
  return catalogOf(await loadFile(HttpTargetSchema, resolve(project.dir, permission.target)));
}

export function validateMatrices(matrices: readonly PermissionMatrix[], catalog: MatrixCatalog): void {
  const issues = matrices.flatMap((m) => matrixIssues(m, catalog).map((i) => `${m.matrixId}: ${i}`));
  if (issues.length > 0) throw new ValidationError("permission matrices are invalid", issues);
}

/** State of one run, threaded through the stages below. */
interface RunSession {
  options: RunOptions;
  project: LoadedProject;
  runId: string;
  runDir: string;
  commitSha: string;
  now: () => Date;
  signal: AbortSignal;
  /** Set once the target exists; the redactor reads its secrets lazily. */
  targetRef: { current?: Target };
  redactor: Redactor;
  evidence: FileEvidenceWriter;
  results: TestResult[];
  lifecycle: LifecycleEvent[];
  missingLaneReports: string[];
}

interface RunPlan {
  selection: ImpactSelection;
  selected: PermissionMatrix[];
  requiredKeys: string[];
}

/**
 * One PR run, in diagram order: S0 route → Phase 0 sources → Phase 1 plan
 * (impact) → permission lane → imported lanes → evidence → reports → gate.
 * Throws ValidationError before any execution when inputs are unsafe to run.
 */
export async function runQa(options: RunOptions): Promise<RunOutcome> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const project = await loadProject(options.configPath);
  const session = await openSession(options, project, now);
  const sources = await checkSources(project.manifest, dirname(project.manifestPath), project.matrices);
  const plan = planRun(project, options.context.changedFiles);

  if (sources.approved || !project.policy.requireSourceApproval) await executeMatrices(session, plan.selected);
  else await recordUnapproved(session, plan.selected, sources.issues);
  await ingestLanes(session);
  await session.evidence.writeIndex();
  scrubFreeText(session);

  const record = buildRecord(session, plan, { manifestId: project.manifest.manifestId, ...sources }, startedAt);
  // The record is re-loaded by `gate`; validating it here catches a contract drift at the source.
  RunRecordSchema.parse(record);
  const gate = gateRecord(record, project.policy, session.commitSha, now());
  await writeOutputs(session.runDir, record, gate);
  return { runDir: session.runDir, record, gate, exitCode: exitCodeForVerdict(gate.verdict) };
}

async function openSession(options: RunOptions, project: LoadedProject, now: () => Date): Promise<RunSession> {
  const { config } = project;
  const commitSha = options.context.headSha;
  const runId = options.runId ?? newRunId(now(), commitSha);
  const runDir = resolve(options.outDir ?? resolve(project.dir, config.evidence.directory), runId);
  // A run directory is an audit record: never write a second run into it.
  if ((await readdir(runDir).catch(() => [])).length > 0) throw new ValidationError("run directory already exists", [runDir]);
  await mkdir(runDir, { recursive: true });
  const targetRef: RunSession["targetRef"] = {};
  const redactor = new Redactor({
    headers: config.evidence.redactHeaders,
    fields: config.evidence.redactFields,
    secrets: () => targetRef.current?.secrets() ?? [],
  });
  const evidence = new FileEvidenceWriter(runDir, redactor, {
    includeResponseBodies: config.evidence.includeResponseBodies,
    maxBodyBytes: config.evidence.maxBodyBytes,
  });
  return {
    options,
    project,
    runId,
    runDir,
    commitSha,
    now,
    signal: options.signal ?? new AbortController().signal,
    targetRef,
    redactor,
    evidence,
    results: [],
    lifecycle: [],
    missingLaneReports: [],
  };
}

/** Phase 1: impact-based selection of matrices; required keys come from the selected matrices. */
function planRun(project: LoadedProject, changedFiles: readonly string[] | undefined): RunPlan {
  const selection = selectByImpact(project.config.impact, project.matrices.map((m) => m.matrixId), changedFiles);
  const selected = project.matrices.filter((m) => selection.matrices.includes(m.matrixId));
  const requiredKeys = selected.flatMap((m) =>
    m.probes.filter((p) => p.required).map((p) => testKey({ lane: PERMISSION_LANE, suiteId: m.matrixId, testId: p.id })),
  );
  return { selection, selected, requiredKeys };
}

type Execution = NonNullable<LoadedProject["config"]["permission"]>["execution"];

async function executeMatrices(session: RunSession, selected: readonly PermissionMatrix[]): Promise<void> {
  const { options, project } = session;
  const execution = project.config.permission?.execution;
  // Matrices come only from the permission section, so none are selected without it.
  if (selected.length === 0 || !execution) return;
  const target = options.createTarget ? await options.createTarget(project) : await defaultTarget(project, options.env);
  session.targetRef.current = target;
  try {
    // Validate every selected matrix before the first probe: one bad matrix stops the whole run.
    validateMatrices(selected, { operations: target.registry, fixtures: target.fixtures, roleOf: (ref) => target.actors.roleOf(ref) });
    for (const matrix of selected) await executeMatrix(session, matrix, { target, execution });
  } finally {
    await target.close();
  }
}

async function executeMatrix(
  session: RunSession,
  matrix: PermissionMatrix,
  { target, execution }: { target: Target; execution: Execution },
): Promise<void> {
  const { project, runId, commitSha, signal, evidence, now } = session;
  const run = await runMatrix(
    matrix,
    { runId, commitSha, environment: project.config.project.environment, signal },
    {
      target,
      evidence,
      defaultTimeoutMs: execution.defaultTimeoutMs,
      cleanupTimeoutMs: execution.cleanupTimeoutMs,
      stopOnCriticalViolation: execution.stopOnCriticalViolation,
      now,
    },
  );
  session.results.push(...run.results);
  session.lifecycle.push(...run.lifecycle);
}

/** Unapproved expectations are not executed: each planned probe is recorded as SKIPPED with the reason. */
async function recordUnapproved(session: RunSession, selected: readonly PermissionMatrix[], issues: readonly string[]): Promise<void> {
  for (const matrix of selected) {
    for (const probe of matrix.probes) {
      const result = unapprovedResult(session, matrix, probe);
      result.evidenceRefs = await session.evidence.write(result, { sources: issues });
      session.results.push(result);
    }
  }
}

function unapprovedResult(session: RunSession, matrix: PermissionMatrix, probe: PermissionProbe): TestResult {
  const at = session.now().toISOString();
  return omitUndefined<TestResult>({
    runId: session.runId,
    lane: PERMISSION_LANE,
    suiteId: matrix.matrixId,
    suiteVersion: matrix.version,
    testId: probe.id,
    required: probe.required,
    status: "SKIPPED",
    category: "SOURCES_NOT_APPROVED",
    severity: probe.severity,
    actorRef: probe.actorRef,
    role: matrix.actors.find((a) => a.ref === probe.actorRef)?.role ?? "unknown",
    operationId: probe.operationId,
    expected: probe.expected,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    evidenceRefs: [],
    failureReason: "Phase 0 sources are not approved; probe not executed",
  });
}

/** Lanes run by other tools: their JUnit reports are copied into the run so artifacts are self-contained. */
async function ingestLanes(session: RunSession): Promise<void> {
  const { runId, runDir } = session;
  for (const [lane, laneConfig] of Object.entries(session.project.config.lanes)) {
    const copies = await copyLaneReports(session, lane, laneConfig.junit);
    const intake = await ingestJUnit(copies, { runId, lane, required: laneConfig.required, baseDir: runDir, now: session.now() });
    session.results.push(...intake.results);
    session.missingLaneReports.push(...intake.missingFiles);
  }
}

async function copyLaneReports(session: RunSession, lane: string, files: readonly string[]): Promise<string[]> {
  const copies: string[] = [];
  for (const [i, file] of files.entries()) {
    const copy = join(session.runDir, "evidence", "lanes", lane, `${i}-${basename(file)}`);
    try {
      await mkdir(dirname(copy), { recursive: true });
      await copyFile(resolve(session.project.dir, file), copy);
      copies.push(copy);
    } catch {
      session.missingLaneReports.push(file);
    }
  }
  return copies;
}

/** Error text can echo adapter internals (URLs, tokens); scrub it before it reaches reports, JUnit or CI summaries. */
function scrubFreeText(session: RunSession): void {
  const scrub = (text: string | undefined): string | undefined => (text === undefined ? undefined : session.redactor.text(text));
  session.results.forEach((r, i) => {
    session.results[i] = omitUndefined({ ...r, failureReason: scrub(r.failureReason), evidenceError: scrub(r.evidenceError) });
  });
  session.lifecycle.forEach((e, i) => {
    session.lifecycle[i] = omitUndefined({ ...e, error: scrub(e.error) });
  });
}

function buildRecord(session: RunSession, plan: RunPlan, sources: RunRecord["sources"], startedAt: Date): RunRecord {
  const { project, options, commitSha } = session;
  const { context } = options;
  return omitUndefined<RunRecord>({
    schemaVersion: 1,
    kitVersion: KIT_VERSION,
    runId: session.runId,
    project: { id: project.config.project.id, environment: project.config.project.environment },
    commitSha,
    pullRequest: omitUndefined({
      provider: context.provider,
      id: context.pullRequestId,
      title: context.title,
      baseSha: context.baseSha,
      headSha: commitSha,
    }),
    startedAt: startedAt.toISOString(),
    finishedAt: session.now().toISOString(),
    plan: omitUndefined({
      mode: plan.selection.mode,
      matrices: plan.selected.map((m) => m.matrixId),
      reasons: plan.selection.reasons,
      requiredKeys: plan.requiredKeys,
      changedFiles: context.changedFiles,
    }),
    matrices: project.matrices.map((m) => ({ matrixId: m.matrixId, version: m.version, sourceRefs: m.sourceRefs })),
    sources,
    route: project.route,
    manual: { cases: project.testCases, results: project.manualResults },
    lifecycle: session.lifecycle,
    missingLaneReports: session.missingLaneReports,
    results: session.results,
    evidenceIndex: [...session.evidence.entries()],
  });
}

export function gateRecord(
  record: RunRecord,
  policy: LoadedProject["policy"],
  commitSha: string,
  now: Date,
): ReleaseGateResult {
  return evaluateGate({
    results: record.results,
    plannedRequired: record.plan.requiredKeys,
    policy,
    commitSha,
    resultsCommitSha: record.commitSha,
    sources: record.sources,
    route: record.route,
    manual: record.manual,
    lifecycleFailures: record.lifecycle.filter((e) => !e.ok),
    missingLaneReports: record.missingLaneReports,
    now,
  });
}

/** `recordName` lets a re-gate keep the original `run.json` untouched as the audit record. */
export async function writeOutputs(
  runDir: string,
  record: RunRecord,
  gate: ReleaseGateResult,
  recordName = "run.json",
): Promise<void> {
  await writeJson(join(runDir, recordName), record);
  await writeJson(join(runDir, "gate.json"), gate);
  await writeText(join(runDir, "report.md"), renderMarkdown(record, gate));
  await writeText(join(runDir, "summary.md"), renderMarkdown(record, gate, { compact: true }));
  await writeText(join(runDir, "junit.xml"), renderJUnit(record.results));
}
