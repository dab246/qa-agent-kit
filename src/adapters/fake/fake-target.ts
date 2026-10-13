import { ActorError } from "../../core/errors.js";
import type {
  ActorContext,
  OperationRequest,
  OperationResponse,
  Target,
  TemplateContext,
} from "../../core/interfaces.js";

export type FakeOperation = (call: {
  actor: ActorContext;
  request: OperationRequest;
  signal: AbortSignal;
}) => OperationResponse | Promise<OperationResponse>;

export interface FakeTargetSpec {
  actors: Record<
    string,
    {
      role: string;
      /** Resolution throws this message (missing credentials, IdP down, …). */
      failWith?: string;
      /** Simulates a broken provider that hands back another identity. */
      resolveAs?: { actorRef: string; role: string };
    }
  >;
  operations: Record<string, FakeOperation>;
  fixtures?: Record<
    string,
    {
      seed?: (ctx: TemplateContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
      cleanup?: (ctx: TemplateContext) => void | Promise<void>;
    }
  >;
  secrets?: string[];
}

/** In-memory target for deterministic acceptance tests and dry runs. Records every call. */
export class FakeTarget implements Target {
  readonly calls: Array<{ actorRef: string; role: string; operationId: string; input: Record<string, unknown> }> = [];
  readonly seeded: string[] = [];
  readonly cleaned: string[] = [];
  readonly disposed: string[] = [];

  constructor(private readonly spec: FakeTargetSpec) {}

  readonly registry = {
    has: (id: string): boolean => Object.hasOwn(this.spec.operations, id),
    list: (): string[] => Object.keys(this.spec.operations),
    execute: async (actor: ActorContext, request: OperationRequest, signal: AbortSignal): Promise<OperationResponse> => {
      const op = this.spec.operations[request.operationId];
      if (!op) throw new Error(`operation '${request.operationId}' is not registered`);
      this.calls.push({ actorRef: actor.actorRef, role: actor.role, operationId: request.operationId, input: request.input });
      return op({ actor, request, signal });
    },
  };

  readonly actors = {
    roleOf: (ref: string): string | undefined => this.spec.actors[ref]?.role,
    resolve: async (ref: string): Promise<ActorContext> => {
      const actor = this.spec.actors[ref];
      if (!actor) throw new ActorError(`unknown actor '${ref}'`);
      if (actor.failWith) throw new ActorError(actor.failWith);
      const identity = actor.resolveAs ?? { actorRef: ref, role: actor.role };
      return { ...identity, sessionRef: `fake-session:${identity.actorRef}` };
    },
    dispose: async (actor: ActorContext): Promise<void> => {
      this.disposed.push(actor.actorRef);
    },
  };

  readonly fixtures = {
    has: (ref: string): boolean => Object.hasOwn(this.spec.fixtures ?? {}, ref),
    seed: async (ref: string, ctx: TemplateContext): Promise<Record<string, unknown>> => {
      this.seeded.push(ref);
      return (await this.spec.fixtures?.[ref]?.seed?.(ctx)) ?? {};
    },
    cleanup: async (ref: string, ctx: TemplateContext): Promise<void> => {
      this.cleaned.push(ref);
      await this.spec.fixtures?.[ref]?.cleanup?.(ctx);
    },
  };

  secrets(): string[] {
    return this.spec.secrets ?? [];
  }

  async close(): Promise<void> {}
}
