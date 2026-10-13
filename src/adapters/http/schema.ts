import { z } from "zod";
import { FixtureIdSchema, IdSchema, SchemaVersionSchema } from "../../core/schemas.js";

const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "environment variable names are UPPER_SNAKE_CASE");

export const HttpOperationSchema = z
  .strictObject({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** `/projects/{projectId}`: `{name}` is filled from the probe input and URL-encoded. */
    path: z.string().startsWith("/"),
    /** Input keys sent as query parameters. Remaining keys go to the JSON body (non-GET). */
    query: z.array(z.string()).default([]),
    graphql: z.strictObject({ query: z.string().min(1), operationName: z.string().optional() }).optional(),
    /** Where the error code lives in the body, e.g. `errors.0.extensions.code` for GraphQL. */
    errorCodePath: z.string().optional(),
    /** Purely documentary for now: the driver never retries, side effect or not. */
    sideEffect: z.boolean().default(true),
  })
  .refine((op) => !op.graphql || op.method === "POST", { message: "graphql operations must use POST" });
export type HttpOperation = z.infer<typeof HttpOperationSchema>;

export const ActorAuthSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("bearer-env"),
    tokenEnv: EnvNameSchema,
    header: z.string().default("authorization"),
    scheme: z.string().default("Bearer"),
  }),
  z.strictObject({
    kind: z.literal("login"),
    operationId: IdSchema,
    usernameEnv: EnvNameSchema,
    passwordEnv: EnvNameSchema,
    /** Optional second factor, e.g. a TOTP or a static test OTP from the CI secret store. */
    otpEnv: EnvNameSchema.optional(),
    usernameField: z.string().default("username"),
    passwordField: z.string().default("password"),
    otpField: z.string().default("otp"),
    tokenPath: z.string().min(1),
    header: z.string().default("authorization"),
    scheme: z.string().default("Bearer"),
  }),
]);

const FixtureStepSchema = z.strictObject({
  operationId: IdSchema,
  actorRef: IdSchema,
  input: z.record(z.string(), z.unknown()).default({}),
});

export const HttpTargetSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  baseUrl: z.string().url().optional(),
  baseUrlEnv: EnvNameSchema.optional(),
  defaultHeaders: z.record(z.string(), z.string()).default({}),
  operations: z.record(IdSchema, HttpOperationSchema),
  actors: z.record(IdSchema, z.strictObject({ role: IdSchema, auth: ActorAuthSchema })),
  fixtures: z
    .record(
      FixtureIdSchema,
      z.strictObject({
        seed: FixtureStepSchema.extend({
          /** name → JSON path in the seed response; exposed as `{{fixture.<id>.<name>}}`. */
          capture: z.record(z.string(), z.string()).default({}),
        }),
        cleanup: FixtureStepSchema.optional(),
      }),
    )
    .default({}),
});
export type HttpTargetConfig = z.infer<typeof HttpTargetSchema>;
