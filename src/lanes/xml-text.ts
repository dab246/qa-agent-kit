/**
 * Decodes the five predefined XML entities and numeric character references
 * in text the parser left raw. The parser never expands entities (no DTD, no
 * "billion laughs"); this single pass only turns `&gt;` back into `>`, so
 * `&amp;lt;` becomes `&lt;`, never `<`. Plain string scanning, no regex
 * backtracking: the lookahead for `;` is bounded, so the cost is linear.
 */
const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** Longest entity body we decode: `#x10FFFF`. */
const MAX_BODY = 8;
const DECIMAL = /^[0-9]{1,7}$/;
const HEX = /^[0-9a-fA-F]{1,6}$/;

const XML_WHITESPACE = new Set([0x9, 0xa, 0xd]);

function isAllowedCodePoint(code: number): boolean {
  if (code < 0x20) return XML_WHITESPACE.has(code);
  const surrogate = code >= 0xd800 && code <= 0xdfff;
  return code <= 0x10ffff && !surrogate;
}

function numericValue(body: string): string | undefined {
  const hex = body.startsWith("#x") || body.startsWith("#X");
  const digits = body.slice(hex ? 2 : 1);
  if (!(hex ? HEX : DECIMAL).test(digits)) return undefined;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  // Other control characters and surrogates stay encoded rather than reach reports.
  return isAllowedCodePoint(code) ? String.fromCodePoint(code) : undefined;
}

function entityValue(body: string): string | undefined {
  if (Object.hasOwn(NAMED, body)) return NAMED[body];
  return body.startsWith("#") ? numericValue(body) : undefined;
}

export function decodeXmlText(text: string): string {
  let out = "";
  let cursor = 0;
  for (let amp = text.indexOf("&"); amp !== -1; amp = text.indexOf("&", amp + 1)) {
    const semi = text.slice(amp + 1, amp + 2 + MAX_BODY).indexOf(";");
    const value = semi === -1 ? undefined : entityValue(text.slice(amp + 1, amp + 1 + semi));
    if (value === undefined) continue;
    out += text.slice(cursor, amp) + value;
    cursor = amp + 2 + semi;
  }
  return out + text.slice(cursor);
}
