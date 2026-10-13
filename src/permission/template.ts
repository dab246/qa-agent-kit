import { getPath, type PathLookup } from "../core/json-path.js";
import type { TemplateContext } from "../core/interfaces.js";

/**
 * Resolves `{{run.id}}` and `{{fixture.<id>.<path>}}` placeholders in probe
 * inputs. A string that is exactly one placeholder keeps the value's type
 * (numeric ids stay numbers). Plain string scanning, no regex.
 */
export interface Resolved<T> {
  value: T;
  unresolved: string[];
}

/** A placeholder reference such as `run.id` or `fixture.user-project.id`. */
type Reference = string;
/** Text that may contain `{{…}}` placeholders. */
type TemplateText = string;

const NOT_FOUND: PathLookup = { found: false };
const FIXTURE_PREFIX = "fixture.";

/** One resolution pass: looks references up in the context and records the ones it cannot resolve. */
class Resolver {
  readonly unresolved: Reference[] = [];

  constructor(private readonly context: TemplateContext) {}

  walk(node: unknown): unknown {
    if (typeof node === "string") return this.text(node);
    if (Array.isArray(node)) return node.map((n) => this.walk(n));
    if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, this.walk(v)]));
    return node;
  }

  private text(text: TemplateText): unknown {
    if (!text.includes("{{")) return text;
    const ref = wholePlaceholder(text);
    return ref === undefined ? this.interpolate(text) : this.whole(ref, text);
  }

  /** Whole-value placeholder: keeps the original type. */
  private whole(ref: Reference, text: TemplateText): unknown {
    const hit = this.lookup(ref);
    if (hit.found) return hit.value;
    this.unresolved.push(ref);
    return text;
  }

  private interpolate(text: TemplateText): string {
    let out = "";
    let cursor = 0;
    for (const { start, end } of placeholders(text)) {
      out += text.slice(cursor, start) + this.replacement(text.slice(start, end));
      cursor = end;
    }
    return out + text.slice(cursor);
  }

  /** `{{ref}}` → its value as text, or the placeholder unchanged when unresolved. */
  private replacement(placeholder: TemplateText): string {
    const ref = placeholder.slice(2, -2).trim();
    const hit = this.lookup(ref);
    if (hit.found) return typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value);
    this.unresolved.push(ref);
    return placeholder;
  }

  private lookup(ref: Reference): PathLookup {
    if (ref === "run.id") return { found: true, value: this.context.runId };
    return ref.startsWith(FIXTURE_PREFIX) ? this.fixture(ref.slice(FIXTURE_PREFIX.length)) : NOT_FOUND;
  }

  /** `<id>[.<path>]` of a fixture: only values a seed captured; null/undefined count as unresolved. */
  private fixture(rest: Reference): PathLookup {
    const dot = rest.indexOf(".");
    const fixtureId = dot === -1 ? rest : rest.slice(0, dot);
    if (!Object.hasOwn(this.context.fixtures, fixtureId)) return NOT_FOUND;
    const hit = getPath(this.context.fixtures[fixtureId], dot === -1 ? "" : rest.slice(dot + 1));
    return hit.value === undefined || hit.value === null ? NOT_FOUND : hit;
  }
}

/** Spans of every complete `{{…}}` placeholder, left to right. */
function placeholders(text: TemplateText): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let start = text.indexOf("{{"); start !== -1; ) {
    const close = text.indexOf("}}", start + 2);
    if (close === -1) break;
    spans.push({ start, end: close + 2 });
    start = text.indexOf("{{", close + 2);
  }
  return spans;
}

/** The reference of a string that is exactly one placeholder, else undefined. */
function wholePlaceholder(text: TemplateText): Reference | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return undefined;
  return trimmed.indexOf("{{", 2) === -1 ? trimmed.slice(2, -2).trim() : undefined;
}

export function resolveTemplates<T>(value: T, context: TemplateContext): Resolved<T> {
  const resolver = new Resolver(context);
  return { value: resolver.walk(value) as T, unresolved: resolver.unresolved };
}
