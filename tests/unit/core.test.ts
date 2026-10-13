import { describe, expect, it } from "vitest";
import { globMatch } from "../../src/core/glob.js";
import { deepEqual, getPath } from "../../src/core/json-path.js";
import { IdSchema } from "../../src/core/schemas.js";
import { maskAuthSchemes, Redactor } from "../../src/evidence/redact.js";
import { resolveTemplates } from "../../src/permission/template.js";
import { md, xml } from "../../src/reporting/escape.js";

/** Median time of `fn` over a few runs, in ms. */
function time(fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[1]!;
}

/** Linear means ~10× time per 10× input; allow generous noise but catch quadratic (100×) growth. */
function expectLinear(make: (n: number) => () => void): void {
  make(10_000)(); // warm up the JIT
  const t100k = Math.max(time(make(100_000)), 0.5);
  const t1m = time(make(1_000_000));
  expect(t1m / t100k).toBeLessThan(40);
  expect(t1m).toBeLessThan(2_000);
}

describe("globMatch", () => {
  it.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["**/*.md", "README.md", true],
    ["docs/?.md", "docs/a.md", true],
    ["docs/?.md", "docs/ab.md", false],
    ["src/settings/**", "src/settingsX/a.ts", false],
  ])("%s ~ %s → %s", (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });

  it("is linear on hostile patterns and paths (no backtracking)", () => {
    expectLinear((n) => () => globMatch("**/*a*a*a*a*a*b", "a/".repeat(n / 2)));
    expectLinear((n) => () => globMatch("*".repeat(20) + "b", "a".repeat(n)));
  });
});

describe("json path", () => {
  it("walks objects and arrays without prototype access", () => {
    expect(getPath({ a: [{ b: 1 }] }, "a.0.b")).toEqual({ found: true, value: 1 });
    expect(getPath({ a: [] }, "a.0")).toEqual({ found: false });
    expect(getPath({}, "constructor")).toEqual({ found: false });
    expect(getPath({}, "__proto__")).toEqual({ found: false });
    expect(getPath({ a: 1 }, "a..b")).toEqual({ found: false });
  });

  it("deepEqual compares structure", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});

describe("templates", () => {
  const ctx = { runId: "r1", fixtures: { f: { id: 7, nested: { name: "x" } } } };

  it("keeps the type of a whole-value placeholder and interpolates partial ones", () => {
    const out = resolveTemplates({ id: "{{fixture.f.id}}", label: "p-{{run.id}}-{{fixture.f.nested.name}}", list: ["{{fixture.f.id}}"] }, ctx);
    expect(out).toEqual({ value: { id: 7, label: "p-r1-x", list: [7] }, unresolved: [] });
  });

  it("reports unresolved references instead of guessing", () => {
    const out = resolveTemplates({ a: "{{fixture.missing.id}}", b: "{{env.SECRET}}", c: "{{fixture.f.none}}" }, ctx);
    expect(out.unresolved).toEqual(["fixture.missing.id", "env.SECRET", "fixture.f.none"]);
  });

  it("cannot reach the environment or prototypes", () => {
    expect(resolveTemplates("{{fixture.f.constructor}}", ctx).unresolved).toHaveLength(1);
    expect(resolveTemplates("{{fixture.__proto__}}", ctx).unresolved).toHaveLength(1);
  });

  it("is linear on unterminated and repeated placeholders", () => {
    expectLinear((n) => () => resolveTemplates("{{".repeat(n / 2), ctx));
    expectLinear((n) => () => resolveTemplates("{{run.id}}x".repeat(n / 11), ctx));
  });
});

describe("redaction", () => {
  const redactor = new Redactor({ headers: ["authorization", "cookie"], fields: ["token", "password"], secrets: () => ["sekret-123", 'q"uote-secret'] });

  it("masks sensitive keys, bearer tokens and known secrets", () => {
    expect(
      redactor.value({ Authorization: "Basic abc", accessToken: "t", user: { Password: "p", bio: "Bearer abc.def-ghi and sekret-123" } }),
    ).toEqual({ Authorization: "[REDACTED]", accessToken: "[REDACTED]", user: { Password: "[REDACTED]", bio: "Bearer [REDACTED] and [REDACTED]" } });
    expect(redactor.text(JSON.stringify({ x: 'q"uote-secret' }))).not.toContain("uote-secret");
  });

  it("keeps text intact when there is nothing to mask", () => {
    expect(maskAuthSchemes("no credentials here; bearer")).toBe("no credentials here; bearer");
  });

  it("is linear on near-miss input", () => {
    expectLinear((n) => () => maskAuthSchemes("beare".repeat(n / 5)));
    expectLinear((n) => () => maskAuthSchemes(`Bearer ${"a".repeat(n)}`));
  });
});

describe("escaping", () => {
  it("md neutralises Markdown, HTML and mentions; xml strips control characters", () => {
    expect(md("[a](b) <i> @x | `c`")).toBe("\\[a\\]\\(b\\) &lt;i&gt; @​x \\| \\`c\\`");
    expect(md("a".repeat(400), 10)).toBe("aaaaaaaaaa…");
    expect(xml('a&<>"\'\u0001b')).toBe("a&amp;&lt;&gt;&quot;&apos;b");
  });

  it("is linear", () => {
    expectLinear((n) => () => md("<[`|".repeat(n / 4), n));
    expectLinear((n) => () => xml("<&\u0001".repeat(n / 3)));
  });
});

describe("id validation regex", () => {
  it("accepts safe ids and rejects separators and traversal", () => {
    expect(IdSchema.safeParse("settings.admin:update-1").success).toBe(true);
    for (const bad of ["../x", "a/b", "-x", ".x", "", "a b", "a".repeat(129)]) expect(IdSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects hostile ids in linear time", () => {
    expectLinear((n) => () => IdSchema.safeParse(`${"a".repeat(n)}!`));
    expectLinear((n) => () => IdSchema.safeParse("a.".repeat(n / 2)));
  });
});
