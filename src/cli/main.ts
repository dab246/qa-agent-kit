#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { detectCi, GitHubActionsAdapter, LocalAdapter, type CiAdapter, type PullRequestContext } from "../adapters/ci/ci.js";
import { renderProposalReview, reviewProposal, TestProposalSchema } from "../ai/proposal.js";
import { buildTriageContext, deterministicTriage, renderTriage, triageIssues, TriageReportSchema } from "../ai/triage.js";
import { ValidationError, errorMessage } from "../core/errors.js";
import { ExitCode } from "../core/exit-codes.js";
import { loadFile, readStructuredFile, parseWith, writeJson, writeText } from "../core/files.js";
import { IdSchema } from "../core/schemas.js";
import { omitUndefined } from "../core/objects.js";
import { KIT_VERSION } from "../core/version.js";
import { selectByImpact } from "../lifecycle/impact.js";
import { checkSources, rehashSources } from "../lifecycle/sources.js";
import { loadProject } from "../orchestrator/project.js";
import { regate } from "../orchestrator/regate.js";
import type { ReleaseGateResult } from "../release-gate/gate.js";
import { runQa, staticCatalog, validateMatrices } from "../orchestrator/run.js";
import { RunRecordSchema } from "../reporting/run-record.js";

const HELP = `qa-agent-kit ${KIT_VERSION}: evidence-driven QA with a deterministic release gate

Usage: qa-agent-kit <command> [options]

Commands
  init <dir>              Scaffold a QA setup from the example suite (config, target, matrix, sources, policy, test pack)
  validate                Validate config, matrices, test packs and target declarations (no network)
  run                     Phase 0 → plan → permission probes → lane intake → evidence → reports → gate
  gate                    Re-evaluate a recorded run (after manual E2E, intake or approval updates)
  impact                  Show which matrices a change selects
  sources check           Phase 0 check of the source manifest
  sources rehash          Re-pin changed source files; approval drops back to PENDING
  proposal review         Review an AI test proposal (advisory; never edits a matrix)
  triage                  Group failures of a run; validate an imported AI triage (advisory)

Common options
  -c, --config <file>     Project config (default: qa-agent-kit.yaml)

run
  --commit <sha>          Commit under test (default: CI event or git HEAD)
  --base <ref>            Base ref for change impact (local)
  --changed-files <file>  Newline-separated changed files (overrides git diff)
  --ci <auto|github|local>
  --run-id <id>  --out <dir>  --summary (publish the compact summary to the CI)

gate      --run <dir|run.json> [--commit <sha>]
impact    --changed-files <file> | --base <ref>
proposal  review --proposal <file> [--out <dir>]
triage    --run <dir> [--import <ai-triage.json>]

Exit codes: 0 GO · 1 NO_GO (failure) · 2 NO_GO (needs review) · 3 invalid input · 4 internal error`;

const options = {
  config: { type: "string", short: "c", default: "qa-agent-kit.yaml" },
  commit: { type: "string" },
  base: { type: "string" },
  "changed-files": { type: "string" },
  ci: { type: "string", default: "auto" },
  "run-id": { type: "string" },
  out: { type: "string" },
  summary: { type: "boolean", default: false },
  run: { type: "string" },
  proposal: { type: "string" },
  import: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

const log = (line: string): void => void process.stderr.write(`${line}\n`);

async function readChangedFiles(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    throw new ValidationError(`cannot read changed-files list ${path}`, [errorMessage(error)]);
  });
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function ciAdapter(values: Values): CiAdapter {
  const cwd = process.cwd();
  const local = { ...(values.commit && { commitSha: values.commit }), ...(values.base && { baseRef: values.base }) };
  if (values.ci === "github") return new GitHubActionsAdapter(process.env, cwd);
  if (values.ci === "local") return new LocalAdapter(cwd, local);
  if (values.ci !== "auto") throw new ValidationError(`unknown --ci '${values.ci}' (auto, github, local)`);
  return detectCi(process.env, cwd, local);
}

async function context(values: Values, ci: CiAdapter): Promise<PullRequestContext> {
  const ctx = await ci.getContext();
  if (values["changed-files"]) return { ...ctx, changedFiles: await readChangedFiles(values["changed-files"]) };
  return ctx;
}

function logGate(label: string, gate: ReleaseGateResult): void {
  log(`${label}: ${gate.decision} (${gate.verdict})`);
  for (const r of gate.reasons.filter((x) => x.level !== "warn")) log(`  [${r.level}] ${r.code} ${r.testKey ?? ""} ${r.message}`);
}

/**
 * First SIGINT/SIGTERM cancels the run (probes stop, cleanup still runs);
 * a second one forces exit.
 */
async function withInterrupts<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(ExitCode.INTERNAL_ERROR);
    log("interrupt: cancelling probes and cleaning up fixtures (repeat to force exit)");
    controller.abort(new Error("cancelled by signal"));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await work(controller.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function assertRunId(runId: string | undefined): void {
  // The run id becomes a directory name: no separators, no '..'.
  if (runId !== undefined && !IdSchema.safeParse(runId).success) throw new ValidationError("invalid --run-id", [runId]);
}

async function cmdRun(values: Values): Promise<number> {
  assertRunId(values["run-id"]);
  const ci = ciAdapter(values);
  return withInterrupts(async (signal) => {
    const outcome = await runQa(
      omitUndefined({
        configPath: values.config,
        context: await context(values, ci),
        env: process.env,
        signal,
        runId: values["run-id"],
        outDir: values.out,
      }),
    );
    logGate(`run ${outcome.record.runId}`, outcome.gate);
    log(`report: ${join(outcome.runDir, "report.md")}`);
    if (values.summary) await ci.publishSummary(await readFile(join(outcome.runDir, "summary.md"), "utf8"));
    // An interrupted run is never better than "needs review".
    return signal.aborted ? Math.max(outcome.exitCode, ExitCode.NO_GO_NEEDS_REVIEW) : outcome.exitCode;
  });
}

async function cmdValidate(values: Values): Promise<number> {
  const project = await loadProject(values.config);
  const catalog = await staticCatalog(project);
  if (catalog) validateMatrices(project.matrices, catalog);
  const sources = await checkSources(project.manifest, join(project.manifestPath, ".."), project.matrices);
  log(
    `valid: ${project.matrices.length} matrix(es), ${project.matrices.reduce((n, m) => n + m.probes.length, 0)} probe(s), ${project.testCases.length} test case(s)`,
  );
  if (!sources.approved) {
    log("Phase 0 is not approved yet (the gate will block until it is):");
    for (const issue of sources.issues) log(`  - ${issue}`);
  }
  return ExitCode.GO;
}

async function cmdGate(values: Values): Promise<number> {
  if (!values.run) throw new ValidationError("gate needs --run <run directory or run.json>");
  const outcome = await regate({ runPath: values.run, configPath: values.config, ...(values.commit && { commitSha: values.commit }) });
  logGate(`run ${outcome.record.runId} re-gated`, outcome.gate);
  return outcome.exitCode;
}

async function cmdImpact(values: Values): Promise<number> {
  const project = await loadProject(values.config);
  let changed: string[] | undefined;
  if (values["changed-files"]) changed = await readChangedFiles(values["changed-files"]);
  else if (values.base) changed = (await new LocalAdapter(process.cwd(), { baseRef: values.base }).getContext()).changedFiles;
  const selection = selectByImpact(project.config.impact, project.matrices.map((m) => m.matrixId), changed);
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  return ExitCode.GO;
}

async function cmdSources(values: Values, action: string | undefined): Promise<number> {
  const project = await loadProject(values.config);
  const dir = join(project.manifestPath, "..");
  if (action === "check") {
    const check = await checkSources(project.manifest, dir, project.matrices);
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    return check.approved ? ExitCode.GO : ExitCode.NO_GO_NEEDS_REVIEW;
  }
  if (action === "rehash") {
    const { manifest, changed } = await rehashSources(project.manifest, dir);
    if (changed.length === 0) {
      log("no source changed");
      return ExitCode.GO;
    }
    const text = extname(project.manifestPath) === ".json" ? `${JSON.stringify(manifest, null, 2)}\n` : stringify(manifest);
    await writeFile(project.manifestPath, text, "utf8");
    log(`re-pinned ${changed.join(", ")}; status UNVERIFIED and approval PENDING until re-reviewed (Phase 0)`);
    return ExitCode.NO_GO_NEEDS_REVIEW;
  }
  throw new ValidationError("usage: sources <check|rehash>");
}

async function cmdProposal(values: Values, action: string | undefined): Promise<number> {
  if (action !== "review" || !values.proposal) throw new ValidationError("usage: proposal review --proposal <file>");
  const project = await loadProject(values.config);
  const proposal = await loadFile(TestProposalSchema, values.proposal);
  const catalog = await staticCatalog(project);
  if (!catalog) throw new ValidationError("no permission target configured");
  const review = reviewProposal(
    proposal,
    project.matrices.find((m) => m.matrixId === proposal.matrixId),
    catalog,
    project.manifest,
  );
  const outDir = resolve(values.out ?? resolve(project.dir, project.config.ai.proposalsDirectory));
  await writeText(join(outDir, `${proposal.proposalId}.md`), renderProposalReview(review, proposal));
  await writeJson(join(outDir, `${proposal.proposalId}.review.json`), review);
  const counts = review.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.verdict]: (acc[i.verdict] ?? 0) + 1 }), {});
  log(`proposal ${proposal.proposalId}: ${JSON.stringify(counts)} → ${join(outDir, `${proposal.proposalId}.md`)}`);
  return review.issues.length > 0 ? ExitCode.NO_GO_NEEDS_REVIEW : ExitCode.GO;
}

async function cmdTriage(values: Values): Promise<number> {
  if (!values.run) throw new ValidationError("triage needs --run <run directory>");
  const runDir = resolve(values.run.endsWith(".json") ? join(values.run, "..") : values.run);
  const record = parseWith(RunRecordSchema, await readStructuredFile(join(runDir, "run.json")), "run.json");
  if (values.import) {
    const report = await loadFile(TriageReportSchema, values.import);
    const issues = triageIssues(report, record);
    await writeText(join(runDir, "triage-ai.md"), renderTriage(report, issues));
    log(issues.length > 0 ? `AI triage rejected: ${issues.length} issue(s)` : "AI triage accepted (advisory)");
    return issues.length > 0 ? ExitCode.INVALID_INPUT : ExitCode.GO;
  }
  const report = deterministicTriage(record);
  await writeText(join(runDir, "triage.md"), renderTriage(report));
  await writeJson(join(runDir, "triage-context.json"), buildTriageContext(record));
  log(`triage: ${report.findings.length} finding(s) → ${join(runDir, "triage.md")}; model context → triage-context.json`);
  return ExitCode.GO;
}

async function cmdInit(dir: string | undefined): Promise<number> {
  if (!dir) throw new ValidationError("usage: init <dir>");
  const templates = fileURLToPath(new URL("../../examples/minimal-permission-suite/", import.meta.url));
  const target = resolve(dir);
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0) throw new ValidationError(`${target} is not empty; refusing to overwrite`);
  await cp(templates, target, { recursive: true, errorOnExist: true, force: false });
  log(`scaffolded ${target}; next: edit target.yaml and matrices, then 'qa-agent-kit validate -c ${join(dir, "qa-agent-kit.yaml")}'`);
  return ExitCode.GO;
}

type Command = (values: Values, sub: string | undefined) => Promise<number>;

const COMMANDS: Readonly<Record<string, Command>> = {
  run: (values) => cmdRun(values),
  validate: (values) => cmdValidate(values),
  gate: (values) => cmdGate(values),
  impact: (values) => cmdImpact(values),
  sources: (values, sub) => cmdSources(values, sub),
  proposal: (values, sub) => cmdProposal(values, sub),
  triage: (values) => cmdTriage(values),
  init: (_values, sub) => cmdInit(sub),
};

function exitCodeForError(error: unknown): number {
  if (error instanceof ValidationError) {
    log(`invalid input: ${error.message}`);
    return ExitCode.INVALID_INPUT;
  }
  log(`internal error: ${errorMessage(error)}`);
  return ExitCode.INTERNAL_ERROR;
}

async function dispatch(command: string, values: Values, sub: string | undefined): Promise<number> {
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) {
    log(`unknown command '${command}'\n\n${HELP}`);
    return ExitCode.INVALID_INPUT;
  }
  try {
    return await handler(values, sub);
  } catch (error) {
    return exitCodeForError(error);
  }
}

function parseCli(argv: readonly string[]): ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>> | undefined {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    log(errorMessage(error));
    return undefined;
  }
}

function print(text: string): number {
  process.stdout.write(`${text}\n`);
  return ExitCode.GO;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed) return ExitCode.INVALID_INPUT;
  const { values, positionals } = parsed;
  const [command, sub] = positionals;
  if (values.version) return print(KIT_VERSION);
  if (values.help || command === "help") return print(HELP);
  if (!command) {
    print(HELP);
    return ExitCode.INVALID_INPUT;
  }
  return dispatch(command, values, sub);
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      log(`internal error: ${errorMessage(error)}`);
      process.exitCode = ExitCode.INTERNAL_ERROR;
    },
  );
}
