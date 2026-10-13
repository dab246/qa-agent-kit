import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ValidationError } from "./errors.js";

/** A filesystem path (absolute, or relative to the working directory). */
export type FilePath = string;

/** Parse a YAML or JSON file. YAML aliases are capped to block "billion laughs" payloads. */
export async function readStructuredFile(path: FilePath): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ValidationError(`cannot read ${path}`, [(error as Error).message]);
  }
  try {
    const ext = extname(path).toLowerCase();
    return ext === ".json" ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (error) {
    throw new ValidationError(`cannot parse ${path}`, [(error as Error).message]);
  }
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

export function parseWith<S extends z.ZodType>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ValidationError(`${label} is invalid`, formatZodIssues(parsed.error));
  return parsed.data;
}

export async function loadFile<S extends z.ZodType>(schema: S, path: FilePath): Promise<z.output<S>> {
  return parseWith(schema, await readStructuredFile(path), path);
}

export async function writeText(path: FilePath, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function writeJson(path: FilePath, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
