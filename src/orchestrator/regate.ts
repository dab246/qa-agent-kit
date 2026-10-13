import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { exitCodeForVerdict, type ExitCode } from "../core/exit-codes.js";
import { readStructuredFile, parseWith, sha256 } from "../core/files.js";
import { checkSources } from "../lifecycle/sources.js";
import type { ReleaseGateResult } from "../release-gate/gate.js";
import { RunRecordSchema, type RunRecord } from "../reporting/run-record.js";
import { loadProject } from "./project.js";
import { gateRecord, writeOutputs } from "./run.js";

/** A tampered run.json must not be able to point the check at files outside the run. */
function insideRun(runDir: string, ref: string): boolean {
  const rel = relative(runDir, resolve(runDir, ref));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

async function digestOf(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch {
    return undefined;
  }
}

/** Indexed evidence must match its checksum; lane reports are copied verbatim (not indexed) and only need to exist. */
async function refIsIntact(runDir: string, ref: string, expected: string | undefined): Promise<boolean> {
  if (!insideRun(runDir, ref)) return false;
  const digest = await digestOf(resolve(runDir, ref));
  if (expected !== undefined) return digest === expected;
  return digest !== undefined && ref.startsWith("evidence/lanes/");
}

/** Evidence refs whose file is missing, outside the run directory, or no longer matches its recorded checksum. */
export async function verifyEvidence(runDir: string, record: RunRecord): Promise<Set<string>> {
  const indexed = new Map(record.evidenceIndex.map((e) => [e.ref, e.sha256]));
  const refs = [...new Set(record.results.flatMap((r) => r.evidenceRefs))];
  const intact = await Promise.all(refs.map((ref) => refIsIntact(runDir, ref, indexed.get(ref))));
  return new Set(refs.filter((_, i) => !intact[i]));
}

export interface RegateOptions {
  /** `run.json` or the run directory containing it. */
  runPath: string;
  configPath: string;
  /** Commit the gate decides for; a run produced for another commit is stale. */
  commitSha?: string;
  now?: Date;
}

export interface RegateOutcome {
  runDir: string;
  record: RunRecord;
  gate: ReleaseGateResult;
  exitCode: ExitCode;
}

/**
 * Re-evaluates a recorded run against the current policy, route, manual E2E
 * results and Phase 0 sources, without re-executing probes. Used after a
 * tester records manual results or a QA Lead accepts intake. Evidence is
 * re-verified so edited artifacts cannot produce GO.
 */
export async function regate(options: RegateOptions): Promise<RegateOutcome> {
  const runFile = options.runPath.endsWith(".json") ? resolve(options.runPath) : resolve(options.runPath, "run.json");
  const runDir = dirname(runFile);
  const recorded = parseWith(RunRecordSchema, await readStructuredFile(runFile), runFile);
  const project = await loadProject(options.configPath);

  const bad = await verifyEvidence(runDir, recorded);
  const results = recorded.results.map((r) => {
    const broken = r.evidenceRefs.filter((ref) => bad.has(ref));
    return broken.length > 0 && r.evidenceError === undefined
      ? { ...r, evidenceError: `evidence missing or modified: ${broken.join(", ")}` }
      : r;
  });
  const sources = await checkSources(project.manifest, join(project.manifestPath, ".."), recorded.matrices);
  const record: RunRecord = {
    ...recorded,
    results,
    sources: { manifestId: project.manifest.manifestId, ...sources },
    manual: { cases: project.testCases, results: project.manualResults },
  };
  if (project.route) record.route = project.route;
  else delete record.route;

  const now = options.now ?? new Date();
  const gate = gateRecord(record, project.policy, options.commitSha ?? recorded.commitSha, now);
  await writeOutputs(runDir, record, gate, "regate.json");
  return { runDir, record, gate, exitCode: exitCodeForVerdict(gate.verdict) };
}
