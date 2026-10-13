import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ValidationError } from "../../core/errors.js";
import { omitUndefined } from "../../core/objects.js";

const run = promisify(execFile);

/** PR/commit facts a run is bound to. Free text (title) is untrusted and only ever rendered escaped. */
export interface PullRequestContext {
  provider: string;
  repositoryId?: string;
  pullRequestId?: string;
  title?: string;
  headSha: string;
  baseSha?: string;
  /** Undefined when the diff could not be computed: impact selection then runs everything. */
  changedFiles?: string[];
}

export interface CiAdapter {
  readonly name: string;
  getContext(): Promise<PullRequestContext>;
  /** Publishes a sanitized Markdown summary. Must throw on failure so a lost publication is never silent. */
  publishSummary(markdown: string): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;
/** A git revision: commit SHA, branch or tag. */
type GitRef = string;
/** Working directory of the repository under test. */
type RepoDir = string;

export interface DiffRange {
  base: GitRef;
  head: GitRef;
}

// Anchored single character classes: linear time on any input.
const SHA = /^[0-9a-f]{7,64}$/;
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

function assertRef(ref: GitRef): void {
  // A leading '-' would be read by git as an option.
  if (ref.startsWith("-") || !SAFE_REF.test(ref)) throw new ValidationError("unsafe git ref", [ref]);
}

async function git(args: string[], cwd: RepoDir): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function changedFilesBetween(range: DiffRange, cwd: RepoDir): Promise<string[] | undefined> {
  assertRef(range.base);
  assertRef(range.head);
  try {
    const out = await git(["diff", "--name-only", "-z", `${range.base}...${range.head}`], cwd);
    return out.split("\0").filter((f) => f !== "");
  } catch {
    return undefined;
  }
}

interface PullRequestEvent {
  number?: number;
  title?: string;
  head?: { sha?: string };
  base?: { sha?: string };
}

const isSha = (value: string | undefined): value is GitRef => value !== undefined && SHA.test(value);

/** On pull_request events GITHUB_SHA is a synthetic merge commit; bind the run to the PR head instead. */
function headShaOf(pr: PullRequestEvent | undefined, env: Env): GitRef {
  const sha = pr?.head?.sha ?? env["GITHUB_SHA"];
  if (!isSha(sha)) throw new ValidationError("cannot determine the commit under test", [String(sha)]);
  return sha;
}

function baseShaOf(pr: PullRequestEvent | undefined): GitRef | undefined {
  const sha = pr?.base?.sha;
  if (sha !== undefined && !isSha(sha)) throw new ValidationError("invalid base sha", [sha]);
  return sha;
}

function describePr(pr: PullRequestEvent | undefined): Pick<PullRequestContext, "pullRequestId" | "title"> {
  return omitUndefined({ pullRequestId: pr?.number === undefined ? undefined : `#${pr.number}`, title: pr?.title });
}

export class GitHubActionsAdapter implements CiAdapter {
  readonly name = "github";

  constructor(
    private readonly env: Env,
    private readonly cwd: RepoDir,
  ) {}

  async getContext(): Promise<PullRequestContext> {
    const pr = (await this.readEvent())["pull_request"] as PullRequestEvent | undefined;
    const head = headShaOf(pr, this.env);
    const base = baseShaOf(pr);
    return omitUndefined({
      provider: "github",
      repositoryId: this.env["GITHUB_REPOSITORY"] || undefined,
      ...describePr(pr),
      headSha: head,
      baseSha: base,
      changedFiles: base ? await changedFilesBetween({ base, head }, this.cwd) : undefined,
    });
  }

  private async readEvent(): Promise<Record<string, unknown>> {
    const eventPath = this.env["GITHUB_EVENT_PATH"];
    if (!eventPath) return {};
    try {
      return JSON.parse(await readFile(eventPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new ValidationError("cannot read the GitHub event payload", [(error as Error).message]);
    }
  }

  async publishSummary(markdown: string): Promise<void> {
    const path = this.env["GITHUB_STEP_SUMMARY"];
    if (!path) throw new Error("GITHUB_STEP_SUMMARY is not set");
    await appendFile(path, `${markdown}\n`, "utf8");
  }
}

/** Developer machine or any CI without a dedicated adapter: commit from git, optional base for impact. */
export class LocalAdapter implements CiAdapter {
  readonly name = "local";

  constructor(
    private readonly cwd: RepoDir,
    private readonly options: { commitSha?: GitRef; baseRef?: GitRef } = {},
  ) {}

  async getContext(): Promise<PullRequestContext> {
    const head = this.options.commitSha ?? (await this.gitHead());
    if (!SHA.test(head)) throw new ValidationError("invalid commit sha", [head]);
    const base = this.options.baseRef;
    if (!base) return { provider: "local", headSha: head };
    return { provider: "local", headSha: head, baseSha: base, ...omitUndefined({ changedFiles: await changedFilesBetween({ base, head }, this.cwd) }) };
  }

  private async gitHead(): Promise<GitRef> {
    try {
      return (await git(["rev-parse", "HEAD"], this.cwd)).trim();
    } catch {
      throw new ValidationError("cannot determine the commit under test", ["pass --commit <sha> or run inside a git repository"]);
    }
  }

  async publishSummary(markdown: string): Promise<void> {
    process.stdout.write(`${markdown}\n`);
  }
}

export function detectCi(env: Env, cwd: RepoDir, options: { commitSha?: GitRef; baseRef?: GitRef }): CiAdapter {
  if (env["GITHUB_ACTIONS"] === "true" && !options.commitSha) return new GitHubActionsAdapter(env, cwd);
  return new LocalAdapter(cwd, options);
}
