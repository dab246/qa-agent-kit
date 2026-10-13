/**
 * Path glob matcher for impact rules: `**` spans directories, `*` and `?` stay
 * within one segment, `**\/` may match zero directories. Implemented as a
 * bounded NFA simulation (O(pattern × path)), not a regex, so hostile paths
 * cannot cause catastrophic backtracking.
 */
type Token =
  | { kind: "char"; ch: string }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "globstar"; skip: number };

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**/` can also match nothing at all, so allow skipping the trailing slash too.
      const slash = pattern[i + 2] === "/";
      tokens.push({ kind: "globstar", skip: slash ? 2 : 1 });
      i += 1;
    } else if (ch === "*") {
      tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else {
      tokens.push({ kind: "char", ch });
    }
  }
  return tokens;
}

const isWildcard = (t: Token): boolean => t.kind === "star" || t.kind === "globstar";

/** Epsilon closure: `*` and `**` may match nothing, `**\/` may also skip its slash. */
function closure(tokens: readonly Token[], states: Uint8Array): void {
  tokens.forEach((t, j) => {
    if (!states[j] || !isWildcard(t)) return;
    states[j + 1] = 1;
    if (t.kind === "globstar" && t.skip === 2) states[j + 2] = 1;
  });
}

/** Next state index after consuming `ch` at token `t` (index j), or -1 when `t` rejects it. */
function transition(t: Token, j: number, ch: string): number {
  switch (t.kind) {
    case "char":
      return t.ch === ch ? j + 1 : -1;
    case "any":
      return ch === "/" ? -1 : j + 1;
    case "star":
      return ch === "/" ? -1 : j;
    case "globstar":
      return j;
  }
}

function step(tokens: readonly Token[], states: Uint8Array, ch: string): Uint8Array | undefined {
  const next = new Uint8Array(tokens.length + 1);
  let alive = false;
  tokens.forEach((t, j) => {
    const to = states[j] ? transition(t, j, ch) : -1;
    if (to === -1) return;
    next[to] = 1;
    alive = true;
  });
  return alive ? next : undefined;
}

export function globMatch(pattern: string, path: string): boolean {
  const tokens = tokenize(pattern);
  let states: Uint8Array | undefined = new Uint8Array(tokens.length + 1);
  states[0] = 1;
  closure(tokens, states);
  // UTF-16 units, like the pattern tokens.
  for (let i = 0; i < path.length; i++) {
    states = step(tokens, states, path[i]!);
    if (!states) return false;
    closure(tokens, states);
  }
  return states[tokens.length] === 1;
}
