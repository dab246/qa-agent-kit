/**
 * Untrusted text (PR titles, failure messages, API bodies) is rendered as
 * inert text: no Markdown links/images, no HTML, no table breakouts.
 */
const MD_SPECIAL = new Set(["\\", "`", "*", "_", "[", "]", "|", "#", "!", "(", ")", "~"]);
// Entities rather than backslashes: inert even in renderers that ignore Markdown escapes.
const MD_ENTITY: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" };

const WHITESPACE = new Set(["\n", "\r", "\t"]);

function mdChar(ch: string): string {
  if (WHITESPACE.has(ch)) return " ";
  if (ch === "@") return "@\u200b"; // no accidental mentions in PR comments
  return MD_ENTITY[ch] ?? (MD_SPECIAL.has(ch) ? `\\${ch}` : ch);
}

export function md(text: string | undefined, max = 300): string {
  if (text === undefined || text === "") return "";
  let out = "";
  const limit = Math.min(text.length, max);
  for (let i = 0; i < limit; i++) out += mdChar(text[i]!);
  return text.length > max ? `${out}…` : out;
}

const XML_ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Characters XML 1.0 forbids: below 0x20 except tab, LF and CR. */
function forbiddenInXml(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r";
}

export function xml(text: string | undefined): string {
  if (text === undefined) return "";
  let out = "";
  // Forbidden characters are dropped so a hostile message cannot corrupt the report.
  for (const ch of text) if (!forbiddenInXml(ch)) out += XML_ENTITY[ch] ?? ch;
  return out;
}
