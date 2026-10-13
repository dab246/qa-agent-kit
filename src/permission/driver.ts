import { ActorError, UnresolvedReferenceError, errorMessage } from "../core/errors.js";
import { omitUndefined } from "../core/objects.js";
import type { ActorContext, OperationResponse, Target, TemplateContext } from "../core/interfaces.js";
import type { ExpectedOutcome, PermissionMatrix, PermissionProbe, ResultCategory, TestResult, TestStatus } from "../core/schemas.js";
import type { EvidenceWriter } from "../evidence/writer.js";
import { classifyResponse, isCriticalCategory, severityFor, type AssertionOutcome } from "./classify.js";
import { assertMatrixValid } from "./matrix.js";
import { resolveTemplates } from "./template.js";

export const PERMISSION_LANE = "permission";

export interface RunContext {
  runId: string;
  commitSha: string;
  environment: string;
  signal: AbortSignal;
}

export interface DriverOptions {
  target: Target;
  evidence: EvidenceWriter;
  defaultTimeoutMs: number;
  cleanupTimeoutMs: number;
  stopOnCriticalViolation: boolean;
  now?: () => Date;
}

/** Seeding, actor bootstrap and cleanup events: recorded separately so they never overwrite probe results. */
export interface LifecycleEvent {
  matrixId: string;
  phase: "seed" | "actor" | "cleanup" | "dispose";
  ref: string;
  ok: boolean;
  error?: string;
}

export interface MatrixRun {
  matrixId: string;
  matrixVersion: number;
  results: TestResult[];
  lifecycle: LifecycleEvent[];
}

interface Outcome {
  status: TestStatus;
  category?: ResultCategory;
  reason?: string;
  response?: OperationResponse;
  assertions?: AssertionOutcome[];
  resolvedInput?: Record<string, unknown>;
}

/** Rejects when `signal` aborts, even if the adapter ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === "TimeoutError";

/** Signal for one step: the run's cancellation plus the step's own timeout. */
const stepSignal = (ctx: RunContext, timeoutMs: number): AbortSignal => AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);

interface ActorFailure {
  message: string;
  mismatch: boolean;
}

/** Mutable bookkeeping of one matrix run, shared by the stages below. */
interface MatrixState {
  matrix: PermissionMatrix;
  ctx: RunContext;
  opts: DriverOptions;
  now: () => Date;
  lifecycle: LifecycleEvent[];
  results: TestResult[];
  templates: TemplateContext;
  seedFailures: Map<string, string>;
  seeded: string[];
  actors: Map<string, ActorContext>;
  actorFailures: Map<string, ActorFailure>;
}

/**
 * Walks every probe of a validated matrix: seeds fixtures, resolves each actor
 * exactly as declared, executes the operation once (no retries: probes can have
 * side effects), classifies against the approved expectation, writes evidence,
 * and always cleans up. Every probe yields exactly one result.
 */
export async function runMatrix(matrix: PermissionMatrix, ctx: RunContext, opts: DriverOptions): Promise<MatrixRun> {
  const { target } = opts;
  assertMatrixValid(matrix, {
    operations: target.registry,
    fixtures: target.fixtures,
    roleOf: (ref) => target.actors.roleOf(ref),
  });
  const state: MatrixState = {
    matrix,
    ctx,
    opts,
    now: opts.now ?? (() => new Date()),
    lifecycle: [],
    results: [],
    templates: { runId: ctx.runId, fixtures: {} },
    seedFailures: new Map(),
    seeded: [],
    actors: new Map(),
    actorFailures: new Map(),
  };
  try {
    await seedFixtures(state);
    await bootstrapActors(state);
    await runProbes(state);
  } finally {
    // Teardown runs on every path, with its own budget so a cancelled run still cleans up.
    await teardown(state);
  }
  return { matrixId: matrix.matrixId, matrixVersion: matrix.version, results: state.results, lifecycle: state.lifecycle };
}

function record(state: MatrixState, phase: LifecycleEvent["phase"], ref: string, error?: unknown): void {
  const failed = error !== undefined;
  state.lifecycle.push(omitUndefined({ matrixId: state.matrix.matrixId, phase, ref, ok: !failed, error: failed ? errorMessage(error) : undefined }));
}

/** 1. Seeding: once per matrix, in declaration order. */
async function seedFixtures(state: MatrixState): Promise<void> {
  const { ctx, opts, templates } = state;
  for (const ref of new Set(state.matrix.probes.flatMap((p) => p.fixtureRefs))) {
    if (ctx.signal.aborted) break;
    // Recorded before seeding: a partial seed may still need cleanup.
    state.seeded.push(ref);
    try {
      const signal = stepSignal(ctx, opts.defaultTimeoutMs);
      templates.fixtures[ref] = await raceAbort(opts.target.fixtures.seed(ref, templates, signal), signal);
      record(state, "seed", ref);
    } catch (error) {
      state.seedFailures.set(ref, errorMessage(error));
      record(state, "seed", ref, error);
    }
  }
}

/** 2. Actor bootstrap: each used actor resolved once, its identity cross-checked. */
async function bootstrapActors(state: MatrixState): Promise<void> {
  const used = new Set(state.matrix.probes.map((p) => p.actorRef));
  for (const { ref, role } of state.matrix.actors) {
    if (!used.has(ref) || state.ctx.signal.aborted) continue;
    try {
      state.actors.set(ref, await resolveExactActor(state, ref, role));
      record(state, "actor", ref);
    } catch (error) {
      const mismatch = error instanceof ActorError && error.mismatch;
      state.actorFailures.set(ref, { message: errorMessage(error), mismatch });
      record(state, "actor", ref, error);
    }
  }
}

async function resolveExactActor(state: MatrixState, ref: string, role: string): Promise<ActorContext> {
  const { actors } = state.opts.target;
  const signal = stepSignal(state.ctx, state.opts.defaultTimeoutMs);
  const actor = await raceAbort(actors.resolve(ref, signal), signal);
  if (actor.actorRef === ref && actor.role === role) return actor;
  await actors.dispose(actor).catch(() => undefined);
  throw new ActorError(`resolved '${actor.actorRef}' with role '${actor.role}', expected '${ref}' with role '${role}'`, true);
}

/** 3. Probes, in matrix order. */
async function runProbes(state: MatrixState): Promise<void> {
  let stopped = false;
  for (const probe of state.matrix.probes) {
    const startedAt = state.now();
    const outcome = await probeOutcome(state, probe, stopped);
    const result = buildResult(state, probe, outcome, { startedAt, finishedAt: state.now() });
    await attachEvidence(state, probe, outcome, result);
    state.results.push(result);
    const critical = result.status === "FAIL" && isCriticalCategory(result.category);
    if (state.opts.stopOnCriticalViolation && critical) stopped = true;
  }
}

function probeOutcome(state: MatrixState, probe: PermissionProbe, stopped: boolean): Promise<Outcome> | Outcome {
  if (stopped) return { status: "SKIPPED", category: "STOPPED_AFTER_CRITICAL", reason: "run stopped after a critical violation" };
  if (state.ctx.signal.aborted) return { status: "BLOCKED", category: "CANCELLED", reason: "run was cancelled" };
  return executeProbe(probe, {
    actor: state.actors.get(probe.actorRef),
    actorFailure: state.actorFailures.get(probe.actorRef),
    seedFailures: state.seedFailures,
    templates: state.templates,
    target: state.opts.target,
    ctx: state.ctx,
    timeoutMs: probe.timeoutMs ?? state.opts.defaultTimeoutMs,
  });
}

function actualOf(response: OperationResponse | undefined): TestResult["actual"] {
  return response && omitUndefined({ httpStatus: response.status, errorCode: response.errorCode });
}

interface Span {
  startedAt: Date;
  finishedAt: Date;
}

function buildResult(state: MatrixState, probe: PermissionProbe, outcome: Outcome, span: Span): TestResult {
  const { matrix, ctx } = state;
  return omitUndefined<TestResult>({
    runId: ctx.runId,
    lane: PERMISSION_LANE,
    suiteId: matrix.matrixId,
    suiteVersion: matrix.version,
    testId: probe.id,
    title: probe.title,
    required: probe.required,
    status: outcome.status,
    category: outcome.category,
    severity: severityFor(outcome.category, probe.severity),
    actorRef: probe.actorRef,
    role: matrix.actors.find((a) => a.ref === probe.actorRef)?.role ?? "unknown",
    operationId: probe.operationId,
    resourceRef: probe.resourceRef,
    expected: probe.expected,
    actual: actualOf(outcome.response),
    startedAt: span.startedAt.toISOString(),
    finishedAt: span.finishedAt.toISOString(),
    durationMs: Math.max(0, span.finishedAt.getTime() - span.startedAt.getTime()),
    evidenceRefs: [],
    failureReason: outcome.reason,
  });
}

function evidenceDetails(state: MatrixState, probe: PermissionProbe, outcome: Outcome): Record<string, unknown> {
  const { matrix, ctx } = state;
  const response = outcome.response;
  return {
    context: { commitSha: ctx.commitSha, environment: ctx.environment, matrixVersion: matrix.version },
    request: {
      operationId: probe.operationId,
      actorRef: probe.actorRef,
      input: outcome.resolvedInput ?? probe.input,
      ...(response?.request && { http: response.request }),
    },
    response: response && { status: response.status, errorCode: response.errorCode, headers: response.headers, body: response.body },
    assertions: outcome.assertions,
    source: { matrixId: matrix.matrixId, matrixVersion: matrix.version, sourceRefs: matrix.sourceRefs },
  };
}

async function attachEvidence(state: MatrixState, probe: PermissionProbe, outcome: Outcome, result: TestResult): Promise<void> {
  try {
    result.evidenceRefs = await state.opts.evidence.write(result, evidenceDetails(state, probe, outcome));
  } catch (error) {
    // Evidence loss never upgrades or erases the result; the gate blocks on it (AT-15).
    result.evidenceError = errorMessage(error);
  }
}

/** 4. Teardown: dispose sessions, then clean fixtures in reverse seeding order. */
async function teardown(state: MatrixState): Promise<void> {
  const { target, cleanupTimeoutMs } = state.opts;
  for (const actor of state.actors.values()) {
    await target.actors.dispose(actor).catch((error: unknown) => record(state, "dispose", actor.actorRef, error));
  }
  for (const ref of [...state.seeded].reverse()) {
    try {
      const signal = AbortSignal.timeout(cleanupTimeoutMs);
      await raceAbort(target.fixtures.cleanup(ref, state.templates, signal), signal);
      record(state, "cleanup", ref);
    } catch (error) {
      record(state, "cleanup", ref, error);
    }
  }
}

interface ProbeEnv {
  actor: ActorContext | undefined;
  actorFailure: ActorFailure | undefined;
  seedFailures: ReadonlyMap<string, string>;
  templates: TemplateContext;
  target: Target;
  ctx: RunContext;
  timeoutMs: number;
}

type Readiness = { blocked: Outcome } | { expected: ExpectedOutcome; actor: ActorContext };

/** Either everything a probe needs to run, or the reason it cannot run at all. */
function readiness(probe: PermissionProbe, env: ProbeEnv): Readiness {
  if (!probe.expected) {
    return { blocked: { status: "INCONCLUSIVE", category: "NO_EXPECTATION", reason: "probe has no approved expectation" } };
  }
  const failedSeed = probe.fixtureRefs.find((f) => env.seedFailures.has(f));
  if (failedSeed) {
    const reason = `fixture '${failedSeed}' failed to seed: ${env.seedFailures.get(failedSeed)}`;
    return { blocked: { status: "BLOCKED", category: "SEED_FAILED", reason } };
  }
  if (env.actor) return { expected: probe.expected, actor: env.actor };
  const category = env.actorFailure?.mismatch ? "ACTOR_MISMATCH" : "ACTOR_UNAVAILABLE";
  return { blocked: { status: "BLOCKED", category, reason: env.actorFailure?.message ?? `actor '${probe.actorRef}' was not resolved` } };
}

interface ResolvedProbe {
  input: Record<string, unknown>;
  resourceRef: string | undefined;
  expected: ExpectedOutcome;
  unresolved: string[];
}

function resolveProbe(probe: PermissionProbe, expectedOutcome: ExpectedOutcome, templates: TemplateContext): ResolvedProbe {
  const input = resolveTemplates(probe.input, templates);
  const resource = probe.resourceRef === undefined ? undefined : resolveTemplates(probe.resourceRef, templates);
  // Expectations may assert seeded values (`json-equals id {{fixture.x.id}}`).
  const expected = resolveTemplates(expectedOutcome, templates);
  return {
    input: input.value,
    resourceRef: resource === undefined ? undefined : String(resource.value),
    expected: expected.value,
    unresolved: [...input.unresolved, ...(resource?.unresolved ?? []), ...expected.unresolved],
  };
}

function errorOutcome(error: unknown, signal: AbortSignal, env: ProbeEnv): Outcome {
  if (error instanceof UnresolvedReferenceError) return { status: "INCONCLUSIVE", category: "UNRESOLVED_REFERENCE", reason: error.message };
  const timedOut = isTimeout(error) || (signal.aborted && isTimeout(signal.reason));
  if (timedOut) return { status: "BLOCKED", category: "TIMEOUT", reason: `timed out after ${env.timeoutMs} ms` };
  if (env.ctx.signal.aborted) return { status: "BLOCKED", category: "CANCELLED", reason: "run was cancelled" };
  return { status: "BLOCKED", category: "EXECUTION_ERROR", reason: errorMessage(error) };
}

async function executeProbe(probe: PermissionProbe, env: ProbeEnv): Promise<Outcome> {
  const ready = readiness(probe, env);
  if ("blocked" in ready) return ready.blocked;
  const resolved = resolveProbe(probe, ready.expected, env.templates);
  if (resolved.unresolved.length > 0) {
    return { status: "INCONCLUSIVE", category: "UNRESOLVED_REFERENCE", reason: `unresolved: ${resolved.unresolved.join(", ")}` };
  }
  const request = omitUndefined({ operationId: probe.operationId, input: resolved.input, resourceRef: resolved.resourceRef });
  const signal = stepSignal(env.ctx, env.timeoutMs);
  try {
    const response = await raceAbort(env.target.registry.execute(ready.actor, request, signal), signal);
    const verdict = classifyResponse(resolved.expected, response);
    return omitUndefined<Outcome>({
      status: verdict.status,
      category: verdict.category,
      reason: verdict.reason,
      response,
      assertions: verdict.assertions,
      resolvedInput: resolved.input,
    });
  } catch (error) {
    return { ...errorOutcome(error, signal, env), resolvedInput: resolved.input };
  }
}
