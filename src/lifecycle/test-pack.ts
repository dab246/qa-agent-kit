import { readFile } from "node:fs/promises";
import { ValidationError } from "../core/errors.js";
import type { FilePath } from "../core/files.js";
import { IdSchema } from "../core/schemas.js";

/**
 * Phase 1: test cases are written in Markdown and that Markdown is the source
 * of truth. Format (one `## ` heading per test case):
 *
 *   ## TC-SET-001: Admin updates global settings
 *   - Type: manual-e2e | automated | review
 *   - Lane: ui
 *   - Priority: P1
 *   - Required: yes
 *   - Automation: permission:admin-settings:admin-update-global-settings
 *   - Automation: unit:src/report.test.ts:aggregate > *   (trailing `*`: every test with that prefix)
 *   ### Steps / ### Expected …
 */
export const TC_TYPES = ["manual-e2e", "automated", "review"] as const;
export type TestCaseType = (typeof TC_TYPES)[number];

export interface TestCase {
  id: string;
  title: string;
  type: TestCaseType;
  lane: string;
  priority: string;
  required: boolean;
  /** `lane:suite:test` keys of automated tests that cover this case. */
  automation: string[];
  file: string;
  line: number;
}

type Draft = Partial<TestCase> & { id: string; title: string; line: number };

/** One scanned Markdown line and its 1-based number. */
interface Line {
  text: string;
  no: number;
}

/** A `- Key: value` metadata entry. */
interface MetaEntry {
  key: string;
  value: string;
}

const finish = (d: Draft, file: FilePath): TestCase => ({
  id: d.id,
  title: d.title,
  type: d.type ?? "manual-e2e",
  lane: d.lane ?? "e2e",
  priority: d.priority ?? "P2",
  required: d.required ?? false,
  automation: d.automation ?? [],
  file,
  line: d.line,
});

const isType = (value: string): value is TestCaseType => (TC_TYPES as readonly string[]).includes(value);
const isListItem = (v: string): boolean => v !== "" && v !== "-" && v.toLowerCase() !== "none";

/** Metadata setters; each returns an issue or nothing. Unknown keys are ignored (free-form notes). */
const META: Record<string, (d: Draft, entry: MetaEntry) => string | undefined> = {
  type: (d, { value }) => {
    if (!isType(value)) return `${d.id} has unknown type '${value}' (${TC_TYPES.join(", ")})`;
    d.type = value;
    return undefined;
  },
  lane: (d, { value }) => void (d.lane = value),
  priority: (d, { value }) => void (d.priority = value),
  required: (d, { value }) => void (d.required = ["yes", "true", "y"].includes(value.toLowerCase())),
  // Repeated `- Automation:` lines add up, so test names that contain commas can each get their own line.
  automation: (d, { value }) => void (d.automation = [...(d.automation ?? []), ...value.split(",").map((v) => v.trim()).filter(isListItem)]),
};

/** `## TC-ID: Title` heading → new draft, or an issue for an invalid id. */
function heading(line: Line): Draft | string {
  const text = line.text.slice(3).trim();
  const colon = text.indexOf(":");
  const id = (colon === -1 ? text : text.slice(0, colon)).trim();
  if (!IdSchema.safeParse(id).success) return `test case id '${id}' is not a valid id`;
  return { id, title: colon === -1 ? id : text.slice(colon + 1).trim(), line: line.no };
}

function metaEntry(line: Line): MetaEntry | undefined {
  const colon = line.text.indexOf(":");
  if (colon === -1) return undefined;
  return { key: line.text.slice(2, colon).trim().toLowerCase(), value: line.text.slice(colon + 1).trim() };
}

/** Metadata after an invalid heading must not attach to the previous case, so it gets a closed placeholder. */
const CLOSED: Draft = { id: "", title: "", line: 0 };

function startCase(drafts: Draft[], line: Line): string | undefined {
  const draft = heading(line);
  const valid = typeof draft !== "string";
  drafts.push(valid ? draft : { ...CLOSED });
  return valid ? undefined : draft;
}

function continueCase(draft: Draft | undefined, line: Line): string | undefined {
  const open = draft !== undefined && draft.line > 0;
  if (!open || !line.text.startsWith("- ")) return undefined;
  const entry = metaEntry(line);
  return entry && META[entry.key]?.(draft, entry);
}

function duplicateIds(cases: readonly TestCase[], file: FilePath): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const tc of cases) {
    if (seen.has(tc.id)) issues.push(`${file}: test case id '${tc.id}' is duplicated`);
    seen.add(tc.id);
  }
  return issues;
}

/** Line-by-line scan; fenced code blocks are skipped so examples never become test cases. */
export function parseTestPack(markdown: string, file: FilePath): TestCase[] {
  const drafts: Draft[] = [];
  const issues: string[] = [];
  let inCode = false;
  markdown.split("\n").forEach((raw, i) => {
    const line: Line = { text: raw.trimEnd(), no: i + 1 };
    if (line.text.trimStart().startsWith("```")) inCode = !inCode;
    if (inCode) return;
    const issue = line.text.startsWith("## ") ? startCase(drafts, line) : continueCase(drafts.at(-1), line);
    if (issue) issues.push(`${file}:${line.no}: ${issue}`);
  });
  const cases = drafts.filter((d) => d.line > 0).map((d) => finish(d, file));
  issues.push(...duplicateIds(cases, file));
  if (issues.length > 0) throw new ValidationError(`test pack ${file} is invalid`, issues);
  return cases;
}

async function readPack(file: FilePath): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new ValidationError(`cannot read test pack ${file}`, [(error as Error).message]);
  }
}

export async function loadTestPacks(files: readonly FilePath[]): Promise<TestCase[]> {
  const all: TestCase[] = [];
  for (const file of files) all.push(...parseTestPack(await readPack(file), file));
  const owner = new Map<string, FilePath>();
  const dupes: string[] = [];
  for (const tc of all) {
    const other = owner.get(tc.id);
    if (other !== undefined && other !== tc.file) dupes.push(`${tc.id} (${other}, ${tc.file})`);
    owner.set(tc.id, tc.file);
  }
  if (dupes.length > 0) throw new ValidationError("test case ids are duplicated across packs", dupes);
  return all;
}
