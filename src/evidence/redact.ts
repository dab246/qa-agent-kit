export const REDACTED = "[REDACTED]";

export interface RedactionOptions {
  headers: readonly string[];
  fields: readonly string[];
  /** Exact secret values known at runtime (tokens, passwords) masked wherever they appear. */
  secrets?: () => readonly string[];
}

/**
 * Three layers, applied before anything is persisted or published:
 * 1. header names and body keys that look sensitive;
 * 2. any `Bearer <token>` value (Basic credentials are covered by header names);
 * 3. every secret value the run loaded, verbatim and JSON-escaped.
 */
export class Redactor {
  private readonly headers: Set<string>;
  private readonly fields: string[];

  constructor(private readonly options: RedactionOptions) {
    this.headers = new Set(options.headers.map((h) => h.toLowerCase()));
    this.fields = options.fields.map((f) => f.toLowerCase());
  }

  isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    return this.headers.has(lower) || this.fields.some((f) => lower.includes(f));
  }

  headersOf(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, this.isSensitiveKey(k) ? REDACTED : this.text(v)]),
    );
  }

  value(node: unknown): unknown {
    if (typeof node === "string") return this.text(node);
    if (Array.isArray(node)) return node.map((n) => this.value(n));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, this.isSensitiveKey(k) ? REDACTED : this.value(v)]),
      );
    }
    return node;
  }

  text(input: string): string {
    let out = maskAuthSchemes(input);
    for (const secret of this.options.secrets?.() ?? []) {
      if (secret.length < 4) continue; // too short to mask without destroying unrelated text
      out = out.split(secret).join(REDACTED);
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join(REDACTED);
    }
    return out;
  }
}

const SCHEME = "bearer ";
const isTokenChar = (c: string): boolean => c > " " && c !== '"' && c !== "'" && c !== "," && c !== ";";

/** Masks the credential after `Bearer ` (case-insensitive). Linear scan, no regex. */
export function maskAuthSchemes(input: string): string {
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    // Compare slice by slice: toLowerCase() on the whole string can change its length.
    if (input.slice(i, i + SCHEME.length).toLowerCase() !== SCHEME) {
      i++;
      continue;
    }
    const start = i + SCHEME.length;
    let end = start;
    while (end < input.length && isTokenChar(input[end]!)) end++;
    if (end > start) {
      out += input.slice(cursor, start) + REDACTED;
      cursor = end;
    }
    i = Math.max(end, i + 1);
  }
  return out + input.slice(cursor);
}
