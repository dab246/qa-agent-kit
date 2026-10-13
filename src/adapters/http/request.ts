import { UnresolvedReferenceError, ValidationError } from "../../core/errors.js";
import type { HttpOperation } from "./schema.js";

export interface BuiltRequest {
  url: URL;
  /** Path plus the names (never values) of query parameters: safe for evidence. */
  displayUrl: string;
  body?: unknown;
}

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

/** Fills `{name}` path parameters from the input, URL-encoded. Plain string scanning, no regex. */
function fillPath(template: string, input: Record<string, unknown>, used: Set<string>): string {
  const missing: string[] = [];
  let path = "";
  let cursor = 0;
  for (let open = template.indexOf("{"); open !== -1; open = template.indexOf("{", cursor)) {
    const close = template.indexOf("}", open);
    if (close === -1) break;
    const name = template.slice(open + 1, close);
    path += template.slice(cursor, open);
    if (isBlank(input[name])) missing.push(`input.${name}`);
    else path += encodeURIComponent(String(input[name]));
    used.add(name);
    cursor = close + 1;
  }
  if (missing.length > 0) throw new UnresolvedReferenceError(missing);
  return path + template.slice(cursor);
}

function joinUrl(baseUrl: URL, path: string): URL {
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
  return new URL(baseUrl.origin + basePath + path);
}

function applyQuery(url: URL, keys: readonly string[], input: Record<string, unknown>, used: Set<string>): string[] {
  const sent = keys.filter((key) => input[key] !== undefined);
  for (const key of sent) {
    url.searchParams.set(key, String(input[key]));
    used.add(key);
  }
  return sent;
}

function bodyFor(op: HttpOperation, rest: Record<string, unknown>): unknown {
  if (op.graphql) {
    const { query, operationName } = op.graphql;
    return operationName ? { query, operationName, variables: rest } : { query, variables: rest };
  }
  if (op.method !== "GET" && op.method !== "DELETE") return rest;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new ValidationError(`input keys not mapped to path or query for ${op.method} ${op.path}`, extra);
  return undefined;
}

/** Path params, then query keys, then the rest goes to the JSON body (or GraphQL variables). */
export function buildRequest(baseUrl: URL, op: HttpOperation, input: Record<string, unknown>): BuiltRequest {
  const used = new Set<string>();
  const url = joinUrl(baseUrl, fillPath(op.path, input, used));
  const sentQuery = applyQuery(url, op.query, input, used);
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !used.has(k)));
  // Query values may carry ids or tokens; evidence only records which keys were sent.
  const displayUrl = sentQuery.length > 0 ? `${url.pathname}?${sentQuery.join("&")}` : url.pathname;
  const body = bodyFor(op, rest);
  return body === undefined ? { url, displayUrl } : { url, displayUrl, body };
}
