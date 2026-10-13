/**
 * Contracts between the deterministic core and the system under test.
 * Adapters implement them; the core never sees URLs, tokens or SDKs.
 */

/** A resolved actor. Carries references only: raw credentials stay inside the adapter. */
export interface ActorContext {
  readonly actorRef: string;
  readonly role: string;
  readonly sessionRef: string;
}

export interface OperationRequest {
  readonly operationId: string;
  readonly input: Record<string, unknown>;
  readonly resourceRef?: string;
}

export interface OperationResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  /** False when the body was truncated or unparseable: body assertions then cannot be trusted. */
  bodyComplete?: boolean;
  /** Application error code (e.g. GraphQL `FORBIDDEN`) when the adapter can extract one. */
  errorCode?: string;
  /** Sanitized request description for evidence: never includes credentials. */
  request?: { method: string; url: string };
}

/** Allowlist of operations: only ids declared here can ever be executed. */
export interface OperationRegistry {
  has(operationId: string): boolean;
  list(): string[];
  execute(actor: ActorContext, request: OperationRequest, signal: AbortSignal): Promise<OperationResponse>;
}

export interface ActorProvider {
  /** Declared role of an actor, used to cross-check the matrix before anything runs. */
  roleOf(actorRef: string): string | undefined;
  /** Must resolve exactly `actorRef` or throw. Never substitutes another identity. */
  resolve(actorRef: string, signal: AbortSignal): Promise<ActorContext>;
  dispose(actor: ActorContext): Promise<void>;
}

export interface FixtureProvider {
  has(fixtureRef: string): boolean;
  /** Seeds the fixture and returns captured values (ids, …) for `{{fixture.<id>.<name>}}`. */
  seed(fixtureRef: string, context: TemplateContext, signal: AbortSignal): Promise<Record<string, unknown>>;
  cleanup(fixtureRef: string, context: TemplateContext, signal: AbortSignal): Promise<void>;
}

export interface TemplateContext {
  runId: string;
  fixtures: Record<string, Record<string, unknown>>;
}

export interface Target {
  readonly registry: OperationRegistry;
  readonly actors: ActorProvider;
  readonly fixtures: FixtureProvider;
  /** Secret values loaded at runtime (tokens, passwords) so evidence can mask them verbatim. */
  secrets(): string[];
  close(): Promise<void>;
}
