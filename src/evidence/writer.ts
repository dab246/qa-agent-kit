import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { sha256, writeJson } from "../core/files.js";
import type { TestResult } from "../core/schemas.js";
import { Redactor } from "./redact.js";

export interface EvidenceWriter {
  /** Persists sanitized evidence for one result and returns references relative to the run directory. */
  write(result: TestResult, details: Record<string, unknown>): Promise<string[]>;
}

export interface EvidenceIndexEntry {
  ref: string;
  sha256: string;
  bytes: number;
}

export interface BodyPolicy {
  includeResponseBodies: boolean;
  maxBodyBytes: number;
}

const fileSafe = (id: string): string => id.replaceAll(":", "_");

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What is stored in place of a response body. */
function storedBody(body: unknown, policy: BodyPolicy): unknown {
  if (!policy.includeResponseBodies) return { omitted: true, topLevelKeys: isPlainObject(body) ? Object.keys(body) : [] };
  const text = JSON.stringify(body) ?? "";
  return text.length <= policy.maxBodyBytes ? body : { truncated: true, preview: text.slice(0, policy.maxBodyBytes) };
}

/** Bodies are omitted by default (only top-level keys are kept); when included they are capped. */
function applyBodyPolicy(details: Record<string, unknown>, policy: BodyPolicy): Record<string, unknown> {
  const response = details["response"];
  if (!isPlainObject(response) || response["body"] === undefined) return details;
  return { ...details, response: { ...response, body: storedBody(response["body"], policy) } };
}

/** Writes one JSON file per result under `<runDir>/evidence/` and keeps a checksum index. */
export class FileEvidenceWriter implements EvidenceWriter {
  private readonly index: EvidenceIndexEntry[] = [];
  /** Case-folded paths already written: on macOS/Windows `A.json` and `a.json` are one file. */
  private readonly taken = new Set<string>();

  constructor(
    private readonly runDir: string,
    private readonly redactor: Redactor,
    private readonly bodyPolicy: BodyPolicy = { includeResponseBodies: false, maxBodyBytes: 16_384 },
  ) {}

  async write(result: TestResult, details: Record<string, unknown>): Promise<string[]> {
    const base = join(this.runDir, "evidence", fileSafe(result.lane), fileSafe(result.suiteId), fileSafe(result.testId));
    let path = `${base}.json`;
    for (let n = 2; this.taken.has(path.toLowerCase()); n++) path = `${base}~${n}.json`;
    this.taken.add(path.toLowerCase());
    const document = {
      schemaVersion: 1,
      testKey: `${result.lane}:${result.suiteId}:${result.testId}`,
      runId: result.runId,
      status: result.status,
      category: result.category,
      // Redact before truncating so a preview string never carries a sensitive key's value.
      details: applyBodyPolicy(this.redactor.value(details) as Record<string, unknown>, this.bodyPolicy),
    };
    // Second pass on the serialized text catches secrets that hid inside non-sensitive keys.
    const content = `${this.redactor.text(JSON.stringify(document, null, 2))}\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    const ref = relative(this.runDir, path).split("\\").join("/");
    this.index.push({ ref, sha256: sha256(content), bytes: Buffer.byteLength(content) });
    return [ref];
  }

  entries(): readonly EvidenceIndexEntry[] {
    return this.index;
  }

  async writeIndex(): Promise<void> {
    await writeJson(join(this.runDir, "evidence", "index.json"), { schemaVersion: 1, entries: this.index });
  }
}
