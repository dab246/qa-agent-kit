import { describe, expect, it } from "vitest";
import { parseJUnit } from "../../src/lanes/junit.js";
import { decodeXmlText } from "../../src/lanes/xml-text.js";
import { parseTestPack } from "../../src/lifecycle/test-pack.js";
import { evaluateGate } from "../../src/release-gate/gate.js";
import { gateInput, result } from "../helpers.js";

function median(fn: () => void): number {
  const t: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return t.sort((a, b) => a - b)[1]!;
}

describe("decodeXmlText", () => {
  it.each([
    ["a &gt; b &lt; c", "a > b < c"],
    ["&quot;x&quot; &apos;y&apos; &amp;", `"x" 'y' &`],
    ["&#65;&#x42;&#X43;", "ABC"],
    ["&amp;lt;", "&lt;"],
    ["&#10;line", "\nline"],
    ["&#1;&#xD800;&#x110000;", "&#1;&#xD800;&#x110000;"],
    ["&unknown; & &; &#; &#xZZ; &lt", "&unknown; & &; &#; &#xZZ; &lt"],
    ["&lol2;", "&lol2;"],
  ])("%j → %j", (input, expected) => {
    expect(decodeXmlText(input)).toBe(expected);
  });

  it("is linear on hostile input (no ';', many entities, near misses)", () => {
    for (const unit of ["&", "&lt;", "&#x4", "&#123456789;"]) {
      const make = (n: number) => () => decodeXmlText(unit.repeat(Math.ceil(n / unit.length)));
      make(10_000)();
      const t100k = Math.max(median(make(100_000)), 0.5);
      const t1m = median(make(1_000_000));
      expect(t1m / t100k).toBeLessThan(40);
      expect(t1m).toBeLessThan(2_000);
    }
  });
});

describe("JUnit from Vitest", () => {
  const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="src/report.test.ts">
  <testcase classname="src/report.test.ts" name="aggregate &gt; sums hours, then rounds"/>
  <testcase classname="ui.Login" name="shows &quot;error&quot;"><failure message="expected &lt;div&gt;"/></testcase>
</testsuite></testsuites>`;

  it("decodes entities and drops a classname that repeats the suite", () => {
    const results = parseJUnit(xml, "/run/x.xml", { runId: "r", lane: "unit", required: true, baseDir: "/run", now: new Date() });
    expect(results.map((r) => [r.suiteId, r.testId, r.failureReason])).toEqual([
      ["src/report.test.ts", "aggregate > sums hours, then rounds", undefined],
      ["src/report.test.ts", 'ui.Login.shows "error"', "expected <div>"],
    ]);
  });
});

describe("traceability links", () => {
  it("repeated Automation lines add up (names may contain commas)", () => {
    const [tc] = parseTestPack(
      "## TC-1: Report\n- Type: automated\n- Automation: unit:a:x, unit:a:y\n- Automation: unit:a:z > *\n",
      "pack.md",
    );
    expect(tc?.automation).toEqual(["unit:a:x", "unit:a:y", "unit:a:z > *"]);
  });

  const cases = (automation: string[]) => ({
    cases: [{ id: "TC-1", title: "t", type: "automated" as const, lane: "unit", priority: "P1", required: true, automation, file: "p.md", line: 1 }],
    results: [],
  });
  const unit = (testId: string, status: "PASS" | "FAIL" | "SKIPPED" = "PASS") => result({ lane: "unit", suiteId: "a", testId, status });

  it("a trailing * links every test with that prefix; all must pass", () => {
    const pass = evaluateGate(gateInput([unit("z > one"), unit("z > two"), unit("other")], { manual: cases(["unit:a:z > *"]) }));
    expect(pass.reasons).toEqual([]);
    const fail = evaluateGate(gateInput([unit("z > one"), unit("z > two", "FAIL")], { manual: cases(["unit:a:z > *"]) }));
    expect(fail.reasons).toContainEqual(expect.objectContaining({ code: "LINKED_TEST_FAILED", testKey: "unit:a:z > two" }));
    const skipped = evaluateGate(gateInput([unit("z > one", "SKIPPED")], { manual: cases(["unit:a:z > *"]) }));
    expect(skipped.reasons.map((r) => r.code)).toContain("LINKED_TEST_NOT_PASSED");
  });

  it("a pattern matching nothing is a traceability gap", () => {
    const gate = evaluateGate(gateInput([unit("other")], { manual: cases(["unit:a:z > *"]) }));
    expect(gate.reasons).toEqual([expect.objectContaining({ code: "TRACEABILITY_GAP" })]);
  });
});
