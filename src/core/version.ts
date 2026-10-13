import { readFileSync } from "node:fs";

/** Read from package.json so reports always record the exact kit version that produced them. */
export const KIT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
