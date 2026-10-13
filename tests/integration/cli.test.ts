import { execFileSync } from "node:child_process";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubActionsAdapter } from "../../src/adapters/ci/ci.js";
import { main } from "../../src/cli/main.js";
import { createDemoServer } from "../../examples/minimal-permission-suite/server.mjs";
import { COMMIT, readTree, tempDir } from "../helpers.js";

const EXAMPLE = new URL("../../examples/minimal-permission-suite/", import.meta.url).pathname;

const CREDENTIALS = {
  QA_REGULAR_USER: "alice",
  QA_REGULAR_PASSWORD: "alice-demo-password",
  QA_OTHER_USER: "bob",
  QA_OTHER_PASSWORD: "bob-demo-password",
  QA_ADMIN_USER: "root",
  QA_ADMIN_PASSWORD: "root-demo-password",
};

async function startApp(bug: boolean): Promise<{ server: Server; url: string }> {
  const server: Server = createDemoServer({ bug });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function suite(): Promise<{ dir: string; config: string; out: string }> {
  const dir = await tempDir();
  await cp(EXAMPLE, dir, { recursive: true });
  return { dir, config: join(dir, "qa-agent-kit.yaml"), out: join(dir, "out") };
}

async function latestRun(out: string): Promise<string> {
  const [run] = (await readdir(out)).sort().reverse();
  return join(out, run!);
}

describe("CLI end to end (real HTTP adapter, demo app)", () => {
  let good: { server: Server; url: string };
  let buggy: { server: Server; url: string };
  beforeAll(async () => {
    good = await startApp(false);
    buggy = await startApp(true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterAll(() => {
    good.server.close();
    buggy.server.close();
    vi.restoreAllMocks();
    for (const key of [...Object.keys(CREDENTIALS), "QA_TARGET_URL"]) delete process.env[key];
  });

  const run = (s: { config: string; out: string }, url: string, extra: string[] = []) => {
    Object.assign(process.env, CREDENTIALS, { QA_TARGET_URL: url });
    return main(["run", "--config", s.config, "--ci", "local", "--commit", COMMIT, "--out", s.out, ...extra]);
  };

  it("a correct app is GO (exit 0) with complete artifacts and no secrets in them", async () => {
    const s = await suite();
    expect(await run(s, good.url)).toBe(0);
    const dir = await latestRun(s.out);
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["run.json", "gate.json", "report.md", "summary.md", "junit.xml", "evidence"]));
    const gate = JSON.parse(await readFile(join(dir, "gate.json"), "utf8"));
    expect(gate).toMatchObject({ decision: "GO", verdict: "GREEN", counts: { PASS: 8 } });
    const tree = await readTree(dir);
    for (const secret of Object.values(CREDENTIALS).filter((v) => v.includes("password"))) expect(tree).not.toContain(secret);
  });

  it("an injected privilege escalation is NO_GO (exit 1)", async () => {
    const s = await suite();
    expect(await run(s, buggy.url)).toBe(1);
    const report = await readFile(join(await latestRun(s.out), "report.md"), "utf8");
    expect(report).toContain("V2 violation");
    expect(report).toContain("PRIVILEGE\\_ESCALATION");
  });

  it("an unreachable target blocks (exit 2), never passes", async () => {
    const s = await suite();
    expect(await run(s, "http://127.0.0.1:9")).toBe(2);
  });

  it("missing manual E2E blocks until the tester records PASS; then `gate` turns GO without re-running probes", async () => {
    const s = await suite();
    const manual = join(s.dir, "manual-results.yaml");
    const recorded = await readFile(manual, "utf8");
    await writeFile(manual, "schemaVersion: 1\nresults: []\n");
    expect(await run(s, good.url)).toBe(2);
    const dir = await latestRun(s.out);
    await writeFile(manual, recorded);
    expect(await main(["gate", "--run", dir, "--config", s.config])).toBe(0);
    // A gate for a newer commit refuses the old results.
    expect(await main(["gate", "--run", dir, "--config", s.config, "--commit", "fedcba9876543210fedcba9876543210fedcba98"])).toBe(2);
  });

  it("change loop: an edited source blocks the run until Phase 0 is re-approved", async () => {
    const s = await suite();
    const policyFile = join(s.dir, "sources/authorization-policy.md");
    await writeFile(policyFile, `${await readFile(policyFile, "utf8")}5. New rule.\n`);
    expect(await main(["sources", "check", "--config", s.config])).toBe(2);
    expect(await run(s, good.url)).toBe(2);
    const record = JSON.parse(await readFile(join(await latestRun(s.out), "run.json"), "utf8"));
    expect(new Set(record.results.filter((r: { lane: string }) => r.lane === "permission").map((r: { category: string }) => r.category))).toEqual(
      new Set(["SOURCES_NOT_APPROVED"]),
    );
    expect(await main(["sources", "rehash", "--config", s.config])).toBe(2);
    const manifest = await readFile(join(s.dir, "source-manifest.yaml"), "utf8");
    expect(manifest).toContain("status: PENDING");
    expect(manifest).toContain("UNVERIFIED");
  });

  it("validate, impact, triage and init", async () => {
    const s = await suite();
    expect(await main(["validate", "--config", s.config])).toBe(0);

    const changed = join(s.dir, "changed.txt");
    await writeFile(changed, "docs/readme.md\n");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["impact", "--config", s.config, "--changed-files", changed])).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({ mode: "selected", matrices: [] });
    stdout.mockRestore();

    expect(await run(s, buggy.url)).toBe(1);
    const dir = await latestRun(s.out);
    expect(await main(["triage", "--run", dir])).toBe(0);
    expect(await readFile(join(dir, "triage.md"), "utf8")).toContain("possible-authorization-regression");
    const context = await readFile(join(dir, "triage-context.json"), "utf8");
    expect(context).not.toContain("demo-password");

    const target = join(await tempDir(), "new-suite");
    expect(await main(["init", target])).toBe(0);
    expect(await main(["validate", "--config", join(target, "qa-agent-kit.yaml")])).toBe(0);
    expect(await main(["init", target])).toBe(3);
  });

  it("invalid input exits 3 and unknown commands are rejected", async () => {
    expect(await main(["validate", "--config", "/nonexistent.yaml"])).toBe(3);
    expect(await main(["frobnicate"])).toBe(3);
    expect(await main(["run", "--bogus-flag"])).toBe(3);
  });
});

describe("GitHub Actions adapter", () => {
  it("binds to the PR head sha and diffs against the base", async () => {
    const repo = await tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    await writeFile(join(repo, "a.txt"), "a");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(repo, "src.ts"), "b");
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    const event = join(repo, "event.json");
    await writeFile(event, JSON.stringify({ pull_request: { number: 7, title: "Add <b>stuff</b>", head: { sha: head }, base: { sha: base } } }));
    const ctx = await new GitHubActionsAdapter({ GITHUB_EVENT_PATH: event, GITHUB_SHA: "f".repeat(40), GITHUB_REPOSITORY: "o/r" }, repo).getContext();
    expect(ctx).toMatchObject({ provider: "github", headSha: head, baseSha: base, pullRequestId: "#7", changedFiles: ["src.ts"] });
  });

  it("rejects malformed shas from the event payload", async () => {
    const dir = await tempDir();
    const event = join(dir, "event.json");
    await writeFile(event, JSON.stringify({ pull_request: { head: { sha: "--upload-pack=evil" }, base: { sha: "x" } } }));
    await expect(new GitHubActionsAdapter({ GITHUB_EVENT_PATH: event }, dir).getContext()).rejects.toThrow(/commit under test/);
  });
});
