/**
 * Minimal dot-path lookup (`data.items.0.id`). Deliberately not an expression
 * language: matrices are data and must not be able to run code.
 */
export interface PathLookup {
  found: boolean;
  value?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** One path segment: array index or own property only (no prototype access). */
function child(node: unknown, segment: string): PathLookup {
  if (Array.isArray(node)) {
    const index = Number(segment);
    const valid = Number.isInteger(index) && index >= 0;
    return valid && index < node.length ? { found: true, value: node[index] } : { found: false };
  }
  if (isObject(node) && Object.hasOwn(node, segment)) return { found: true, value: node[segment] };
  return { found: false };
}

export function getPath(root: unknown, path: string): PathLookup {
  if (path === "" || path === "$") return { found: true, value: root };
  let current: PathLookup = { found: true, value: root };
  for (const segment of path.split(".")) {
    current = segment === "" ? { found: false } : child(current.value, segment);
    if (!current.found) return current;
  }
  return current;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
}

function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (Array.isArray(a)) return Array.isArray(b) && arraysEqual(a, b);
  return !Array.isArray(b) && objectsEqual(a, b);
}
