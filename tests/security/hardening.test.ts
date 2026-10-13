import { readdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFilesBetween } from "../../src/adapters/ci/ci.js";
import { HttpTarget } from "../../src/adapters/http/http-target.js";
import { HttpTargetSchema } from "../../src/adapters/http/schema.js";
import { Redactor } from "../../src/evidence/redact.js";
import { FileEvidenceWriter } from "../../src/evidence/writer.js";
import { ingestJUnit, MAX_JUNIT_BYTES } from "../../src/lanes/junit.js";
import { main } from "../../src/cli/main.js";
import { COMMIT, result, tempDir } from "../helpers.js";

const EXAMPLE = new URL("../../examples/minimal-permission-suite/qa-agent-kit.yaml", import.meta.url).pathname;

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("hardening", () => {
  it("evidence for ids differing only by case never overwrites each other", async () => {
    const dir = await tempDir();
    const writer = new FileEvidenceWriter(dir, new Redactor({ headers: [], fields: [] }));
    const a = await writer.write(result({ testId: "Probe" }), { n: 1 });
    const b = await writer.write(result({ testId: "probe" }), { n: 2 });
    expect(a[0]!.toLowerCase()).not.toBe(b[0]!.toLowerCase());
    expect(await readdir(join(dir, "evidence/permission/m1"))).toHaveLength(2);
  });

  it("only http(s) targets are accepted", () => {
    const config = HttpTargetSchema.parse({ schemaVersion: 1, baseUrl: "file:///etc/passwd", operations: {}, actors: {} });
    expect(() => new HttpTarget(config, { env: {} })).toThrow(/http or https/);
  });

  it("oversized JUnit reports are rejected, not loaded", async () => {
    const file = join(await tempDir(), "huge.xml");
    await writeFile(file, "");
    await truncate(file, MAX_JUNIT_BYTES + 1);
    await expect(ingestJUnit([file], { runId: "r", lane: "ui", required: true, baseDir: "/", now: new Date() })).rejects.toThrow(/above the/);
  });

  it("a run id that already has artifacts cannot be reused", async () => {
    const out = await tempDir();
    await writeFile(join(out, "placeholder"), "");
    const runDir = join(out, "existing-run");
    await (await import("node:fs/promises")).mkdir(runDir);
    await writeFile(join(runDir, "run.json"), "{}");
    expect(await main(["run", "--config", EXAMPLE, "--ci", "local", "--commit", COMMIT, "--out", out, "--run-id", "existing-run"])).toBe(3);
  });

  it("git refs are validated before git runs, so option injection is impossible", async () => {
    await expect(changedFilesBetween({ base: "--output=/tmp/x", head: "HEAD" }, ".")).rejects.toThrow(/unsafe git ref/);
    await expect(changedFilesBetween({ base: "main", head: "a b" }, ".")).rejects.toThrow(/unsafe git ref/);
  });

  it("remaining regexes reject hostile input in linear time", async () => {
    const env = (n: number) => () =>
      HttpTargetSchema.safeParse({ schemaVersion: 1, operations: {}, actors: { a: { role: "r", auth: { kind: "bearer-env", tokenEnv: `${"A".repeat(n)}!` } } } });
    env(10_000)();
    const envTimes = [100_000, 1_000_000].map((n) => timed(env(n)));
    expect(envTimes[1]! / Math.max(envTimes[0]!, 0.5)).toBeLessThan(40);
    const ref = async (n: number) => {
      const start = performance.now();
      await changedFilesBetween({ base: `${"a/".repeat(n / 2)}!`, head: "HEAD" }, ".").catch(() => undefined);
      return performance.now() - start;
    };
    await ref(10_000);
    const [t100k, t1m] = [await ref(100_000), await ref(1_000_000)];
    expect(t1m / Math.max(t100k, 0.5)).toBeLessThan(40);
    expect(t1m).toBeLessThan(2_000);
  });
});
