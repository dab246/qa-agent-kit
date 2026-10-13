import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../../src/config/schema.js";
import { sha256 } from "../../src/core/files.js";
import { SourceManifestSchema } from "../../src/core/schemas.js";
import { parseJUnit } from "../../src/lanes/junit.js";
import { selectByImpact } from "../../src/lifecycle/impact.js";
import { checkSources, rehashSources } from "../../src/lifecycle/sources.js";
import { parseTestPack } from "../../src/lifecycle/test-pack.js";
import { tempDir } from "../helpers.js";

const impact = (rules: unknown[], extra: Record<string, unknown> = {}) =>
  ProjectConfigSchema.shape.impact.parse({ rules, ...extra });

describe("change impact", () => {
  const all = ["auth", "settings"];

  it("runs everything when the change set is unknown or unclaimed", () => {
    expect(selectByImpact(impact([{ paths: ["src/**"], matrices: ["auth"] }]), all, undefined).mode).toBe("all");
    expect(selectByImpact(impact([]), all, ["x"]).mode).toBe("all");
    const unclaimed = selectByImpact(impact([{ paths: ["src/auth/**"], matrices: ["auth"] }]), all, ["src/auth/a.ts", "infra/db.ts"]);
    expect(unclaimed).toMatchObject({ mode: "all", unmatchedFiles: ["infra/db.ts"] });
  });

  it("selects only affected matrices when every file is claimed", () => {
    const sel = selectByImpact(
      impact([{ paths: ["src/auth/**"], matrices: ["auth"], lanes: ["permission"] }, { paths: ["docs/**"] }], { alwaysRun: [] }),
      all,
      ["src/auth/login.ts", "docs/a.md"],
    );
    expect(sel).toMatchObject({ mode: "selected", matrices: ["auth"], lanes: ["permission"] });
  });

  it("falls back to everything when a rule names an unknown matrix", () => {
    expect(selectByImpact(impact([{ paths: ["**"], matrices: ["typo"] }]), all, ["a"]).mode).toBe("all");
  });
});

describe("Phase 0 sources", () => {
  async function setup(status = "VERIFIED") {
    const dir = await tempDir();
    await writeFile(join(dir, "policy.md"), "rule 1");
    const manifest = SourceManifestSchema.parse({
      schemaVersion: 1,
      manifestId: "m",
      sources: [{ id: "policy", type: "policy", revision: "r1", status, path: "policy.md", sha256: sha256("rule 1") }],
      approval: { status: "APPROVED" },
    });
    return { dir, manifest };
  }
  const matrices = [{ matrixId: "m1", sourceRefs: [{ id: "policy", revision: "r1" }] }];

  it("approves verified, unchanged, referenced sources", async () => {
    const { dir, manifest } = await setup();
    expect(await checkSources(manifest, dir, matrices)).toEqual({ approved: true, issues: [], changedSources: [] });
  });

  it("re-opens Phase 0 when a pinned file changes, and rehash drops approval to PENDING", async () => {
    const { dir, manifest } = await setup();
    await writeFile(join(dir, "policy.md"), "rule 1 (edited)");
    const check = await checkSources(manifest, dir, matrices);
    expect(check).toMatchObject({ approved: false, changedSources: ["policy"] });
    const { manifest: next, changed } = await rehashSources(manifest, dir);
    expect(changed).toEqual(["policy"]);
    expect(next.approval.status).toBe("PENDING");
    expect(next.sources[0]).toMatchObject({ status: "UNVERIFIED", sha256: sha256("rule 1 (edited)") });
  });

  it("flags wrong revisions, unverified sources, unknown sources and open assumptions", async () => {
    const { dir, manifest } = await setup("ASSUMPTION");
    const withAssumption = { ...manifest, assumptions: [{ id: "a1", statement: "admins see all", resolved: false }] };
    const check = await checkSources(withAssumption, dir, [
      ...matrices,
      { matrixId: "m2", sourceRefs: [{ id: "policy", revision: "r0" }, { id: "nope", revision: "1" }] },
    ]);
    expect(check.issues).toHaveLength(4);
  });
});

describe("Markdown test packs", () => {
  const pack = `# Pack

## TC-1: Login works
- Type: manual-e2e
- Required: yes

\`\`\`
## TC-FAKE: inside a code block
\`\`\`

## TC-2: Automated
- Type: automated
- Lane: permission
- Automation: permission:m:a, permission:m:b
`;

  it("parses cases and metadata, ignoring code blocks", () => {
    const cases = parseTestPack(pack, "pack.md");
    expect(cases.map((c) => [c.id, c.type, c.required, c.automation])).toEqual([
      ["TC-1", "manual-e2e", true, []],
      ["TC-2", "automated", false, ["permission:m:a", "permission:m:b"]],
    ]);
  });

  it("rejects duplicate ids, unknown types and invalid ids", () => {
    expect(() => parseTestPack("## TC-1: a\n## TC-1: b\n", "p.md")).toThrow(/duplicated/);
    expect(() => parseTestPack("## TC-1: a\n- Type: smoke\n", "p.md")).toThrow(/unknown type/);
    expect(() => parseTestPack("## ../etc: a\n", "p.md")).toThrow(/not a valid id/);
  });
});

describe("JUnit lane intake", () => {
  const options = { runId: "r", lane: "ui", required: true, baseDir: "/runs/1", now: new Date("2026-10-13T00:00:00Z") };

  it("normalises pass, failure, error, skip and nested suites; repeated names stay distinct", () => {
    const xml = `<testsuites><testsuite name="s">
      <testcase classname="c" name="ok" time="0.5"/>
      <testcase classname="c" name="bad"><failure message="boom"/></testcase>
      <testcase classname="c" name="err"><error>stack</error></testcase>
      <testcase classname="c" name="skip"><skipped/></testcase>
      <testcase classname="c" name="ok"/>
      <testsuite name="inner"><testcase name="deep"/></testsuite>
    </testsuite></testsuites>`;
    const results = parseJUnit(xml, "/runs/1/evidence/ui.xml", options);
    expect(results.map((r) => [r.suiteId, r.testId, r.status, r.category])).toEqual([
      ["s", "c.ok", "PASS", undefined],
      ["s", "c.bad", "FAIL", "TEST_FAILED"],
      ["s", "c.err", "FAIL", "TEST_FAILED"],
      ["s", "c.skip", "SKIPPED", "SKIPPED_BY_RUNNER"],
      ["s", "c.ok#2", "PASS", undefined],
      ["s/inner", "deep", "PASS", undefined],
    ]);
    expect(results[0]).toMatchObject({ durationMs: 500, evidenceRefs: ["evidence/ui.xml"] });
    expect(results[1]?.failureReason).toBe("boom");
  });

  it("rejects reports without suites", () => {
    expect(() => parseJUnit("<nothing/>", "x.xml", options)).toThrow(/no <testsuite>/);
  });
});

describe("example config", () => {
  it("parses with defaults applied", async () => {
    const { parse } = await import("yaml");
    const text = await readFile(new URL("../../examples/minimal-permission-suite/qa-agent-kit.yaml", import.meta.url), "utf8");
    const config = ProjectConfigSchema.parse(parse(text));
    expect(config.evidence.redactHeaders).toContain("authorization");
    expect(config.ai.allowChangeApprovedMatrix).toBe(false);
  });
});
