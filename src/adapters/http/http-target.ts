import { randomUUID } from "node:crypto";
import { ActorError, UnresolvedReferenceError, ValidationError } from "../../core/errors.js";
import { omitUndefined } from "../../core/objects.js";
import { loadFile } from "../../core/files.js";
import { getPath } from "../../core/json-path.js";
import type {
  ActorContext,
  OperationRequest,
  OperationResponse,
  Target,
  TemplateContext,
} from "../../core/interfaces.js";
import type { MatrixCatalog } from "../../permission/matrix.js";
import { resolveTemplates } from "../../permission/template.js";
import { buildRequest } from "./request.js";
import { HttpTargetSchema, type HttpOperation, type HttpTargetConfig } from "./schema.js";

type ActorAuth = HttpTargetConfig["actors"][string]["auth"];
type LoginAuth = Extract<ActorAuth, { kind: "login" }>;

/** What a target declares, without connecting: lets `validate` check matrices with no secrets or network. */
export function catalogOf(config: HttpTargetConfig): MatrixCatalog {
  return {
    operations: { has: (id) => Object.hasOwn(config.operations, id) },
    fixtures: { has: (id) => Object.hasOwn(config.fixtures, id) },
    roleOf: (ref) => config.actors[ref]?.role,
  };
}

type Env = Readonly<Record<string, string | undefined>>;

export interface HttpTargetOptions {
  env: Env;
  /** Hostnames the base URL may point at; empty disables the check. */
  allowedHosts?: readonly string[];
  /** Read limit for response bodies (assertions need the whole body). Default 1 MiB. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/**
 * Generic REST/GraphQL target driven by `target.yaml`. Operations, actors and
 * fixtures are declared as data; credentials come only from environment
 * variables and never leave this class except as masked secrets.
 */
export class HttpTarget implements Target {
  private readonly baseUrl: URL;
  private readonly sessions = new Map<string, Record<string, string>>();
  private readonly secretValues = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  static async fromFile(path: string, options: HttpTargetOptions): Promise<HttpTarget> {
    return new HttpTarget(await loadFile(HttpTargetSchema, path), options);
  }

  constructor(
    private readonly config: HttpTargetConfig,
    private readonly options: HttpTargetOptions,
  ) {
    const raw = config.baseUrl ?? (config.baseUrlEnv ? options.env[config.baseUrlEnv] : undefined);
    if (!raw) throw new ValidationError("target base URL is not configured", ["set baseUrl or baseUrlEnv"]);
    try {
      this.baseUrl = new URL(raw);
    } catch {
      throw new ValidationError("target base URL is invalid", [raw]);
    }
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new ValidationError("target base URL must use http or https", [this.baseUrl.protocol]);
    }
    const hosts = options.allowedHosts ?? [];
    if (hosts.length > 0 && !hosts.includes(this.baseUrl.hostname)) {
      throw new ValidationError("target host is not allowlisted", [
        `${this.baseUrl.hostname} is not in safety.allowedHosts (${hosts.join(", ")})`,
      ]);
    }
    const issues: string[] = [];
    for (const [ref, actor] of Object.entries(config.actors)) {
      if (actor.auth.kind === "login" && !config.operations[actor.auth.operationId]) {
        issues.push(`actor '${ref}': login operation '${actor.auth.operationId}' is not declared`);
      }
    }
    for (const [ref, fixture] of Object.entries(config.fixtures)) {
      for (const step of [fixture.seed, fixture.cleanup]) {
        if (!step) continue;
        if (!config.operations[step.operationId]) issues.push(`fixture '${ref}': unknown operation '${step.operationId}'`);
        if (!config.actors[step.actorRef]) issues.push(`fixture '${ref}': unknown actor '${step.actorRef}'`);
      }
    }
    if (issues.length > 0) throw new ValidationError("target configuration is invalid", issues);
    this.fetchImpl = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  }

  readonly registry = {
    has: (id: string): boolean => Object.hasOwn(this.config.operations, id),
    list: (): string[] => Object.keys(this.config.operations),
    execute: (actor: ActorContext, request: OperationRequest, signal: AbortSignal): Promise<OperationResponse> => {
      const headers = this.sessions.get(actor.sessionRef);
      // No session means no request: never fall back to anonymous or another actor's credentials.
      if (!headers) return Promise.reject(new ActorError(`no live session for actor '${actor.actorRef}'`));
      return this.send(request.operationId, request.input, headers, signal);
    },
  };

  readonly actors = {
    roleOf: (ref: string): string | undefined => this.config.actors[ref]?.role,
    resolve: (ref: string, signal: AbortSignal): Promise<ActorContext> => this.resolveActor(ref, signal),
    dispose: async (actor: ActorContext): Promise<void> => {
      this.sessions.delete(actor.sessionRef);
    },
  };

  readonly fixtures = {
    has: (ref: string): boolean => Object.hasOwn(this.config.fixtures, ref),
    seed: async (ref: string, ctx: TemplateContext, signal: AbortSignal): Promise<Record<string, unknown>> => {
      const fixture = this.config.fixtures[ref];
      if (!fixture) throw new Error(`unknown fixture '${ref}'`);
      const response = await this.runStep(fixture.seed, ctx, signal);
      const captured: Record<string, unknown> = {};
      for (const [name, path] of Object.entries(fixture.seed.capture)) {
        const hit = getPath(response.body, path);
        if (!hit.found) throw new Error(`fixture '${ref}': seed response has no '${path}'`);
        captured[name] = hit.value;
      }
      return captured;
    },
    cleanup: async (ref: string, ctx: TemplateContext, signal: AbortSignal): Promise<void> => {
      const step = this.config.fixtures[ref]?.cleanup;
      if (step) await this.runStep(step, ctx, signal);
    },
  };

  secrets(): string[] {
    return [...this.secretValues];
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }

  private async runStep(
    step: { operationId: string; actorRef: string; input: Record<string, unknown> },
    ctx: TemplateContext,
    signal: AbortSignal,
  ): Promise<OperationResponse> {
    const input = resolveTemplates(step.input, ctx);
    if (input.unresolved.length > 0) throw new UnresolvedReferenceError(input.unresolved);
    const actor = await this.resolveActor(step.actorRef, signal);
    try {
      const response = await this.registry.execute(actor, { operationId: step.operationId, input: input.value }, signal);
      if (!isSuccess(response.status)) throw new Error(`${step.operationId} returned HTTP ${response.status}`);
      return response;
    } finally {
      await this.actors.dispose(actor);
    }
  }

  private requireEnv(name: string, actorRef: string): string {
    const value = this.options.env[name];
    if (!value) throw new ActorError(`actor '${actorRef}': environment variable ${name} is not set`);
    this.secretValues.add(value);
    return value;
  }

  private async resolveActor(ref: string, signal: AbortSignal): Promise<ActorContext> {
    const actor = this.config.actors[ref];
    if (!actor) throw new ActorError(`unknown actor '${ref}'`);
    const sessionRef = `${ref}#${randomUUID()}`;
    this.sessions.set(sessionRef, await this.authHeaders(ref, actor.auth, signal));
    return { actorRef: ref, role: actor.role, sessionRef };
  }

  private async authHeaders(ref: string, auth: ActorAuth, signal: AbortSignal): Promise<Record<string, string>> {
    if (auth.kind === "none") return {};
    const token = auth.kind === "bearer-env" ? this.requireEnv(auth.tokenEnv, ref) : await this.login(ref, auth, signal);
    return { [auth.header]: `${auth.scheme} ${token}`.trim() };
  }

  /** Fresh login per resolution (diagram: reAuthenticateActor) so sessions never leak across runs. */
  private async login(ref: string, auth: LoginAuth, signal: AbortSignal): Promise<string> {
    const input: Record<string, unknown> = {
      [auth.usernameField]: this.requireEnv(auth.usernameEnv, ref),
      [auth.passwordField]: this.requireEnv(auth.passwordEnv, ref),
    };
    if (auth.otpEnv) input[auth.otpField] = this.requireEnv(auth.otpEnv, ref);
    const response = await this.send(auth.operationId, input, {}, signal);
    if (!isSuccess(response.status)) throw new ActorError(`actor '${ref}': login returned HTTP ${response.status}`);
    const token = getPath(response.body, auth.tokenPath).value;
    if (typeof token !== "string" || token === "") {
      throw new ActorError(`actor '${ref}': login response has no token at '${auth.tokenPath}'`);
    }
    this.secretValues.add(token);
    return token;
  }

  private async send(
    operationId: string,
    input: Record<string, unknown>,
    authHeaders: Record<string, string>,
    signal: AbortSignal,
  ): Promise<OperationResponse> {
    const op = this.config.operations[operationId];
    if (!op) throw new Error(`operation '${operationId}' is not registered`);
    const { url, displayUrl, body } = buildRequest(this.baseUrl, op, input);
    const headers: Record<string, string> = { accept: "application/json", ...this.config.defaultHeaders, ...authHeaders };
    const init: RequestInit = { method: op.method, headers, signal, redirect: "manual" };
    // A redirect to a login page must surface as 3xx (redirect: "manual"), not as the login page's 200.
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(url, init);
    const { body: parsed, complete } = await readBody(response, this.maxResponseBytes);
    return omitUndefined({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsed,
      bodyComplete: complete,
      errorCode: errorCodeOf(op, parsed),
      request: { method: op.method, url: displayUrl },
    });
  }
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** Application error code, e.g. GraphQL `errors.0.extensions.code`. */
function errorCodeOf(op: HttpOperation, body: unknown): string | undefined {
  const path = op.errorCodePath ?? (op.graphql ? "errors.0.extensions.code" : undefined);
  const value = path === undefined ? undefined : getPath(body, path).value;
  return value === undefined || value === null ? undefined : String(value);
}

/** Reads at most `limit` bytes so a huge response cannot exhaust memory. */
async function readBody(response: Response, limit: number): Promise<{ body: unknown; complete: boolean }> {
  if (!response.body) return { body: undefined, complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      chunks.push(value.subarray(0, value.byteLength - (size - limit)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return { body: undefined, complete: !truncated };
  const type = response.headers.get("content-type") ?? "";
  if (!truncated && type.includes("json")) {
    try {
      return { body: JSON.parse(text), complete: true };
    } catch {
      return { body: { unparsedText: text }, complete: false };
    }
  }
  return { body: { text, truncated }, complete: !truncated };
}
