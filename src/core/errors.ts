/** A config, matrix or input file failed validation; nothing has executed. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join("\n  - ")}` : message);
  }
}

/** A probe input referenced a value (fixture id, path param) that could not be resolved. */
export class UnresolvedReferenceError extends Error {
  override readonly name = "UnresolvedReferenceError";
  constructor(readonly references: readonly string[]) {
    super(`unresolved reference(s): ${references.join(", ")}`);
  }
}

/** Actor resolution failed or returned a different identity than requested. */
export class ActorError extends Error {
  override readonly name = "ActorError";
  constructor(
    message: string,
    readonly mismatch = false,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
