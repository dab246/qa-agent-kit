import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpTarget } from "../../src/adapters/http/http-target.js";
import { HttpTargetSchema } from "../../src/adapters/http/schema.js";
import { createDemoServer } from "../../examples/minimal-permission-suite/server.mjs";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const signal = (): AbortSignal => AbortSignal.timeout(5_000);

describe("HttpTarget against the demo app", () => {
  let server: Server;
  let baseUrl: string;
  const env = {
    U: "alice",
    UP: "alice-demo-password",
    A: "root",
    AP: "root-demo-password",
  };
  const config = () =>
    HttpTargetSchema.parse({
      schemaVersion: 1,
      baseUrl,
      operations: {
        login: { method: "POST", path: "/auth/login" },
        me: { method: "GET", path: "/settings/me" },
        update: { method: "PUT", path: "/admin/settings" },
        create: { method: "POST", path: "/projects" },
        read: { method: "GET", path: "/projects/{projectId}" },
        del: { method: "DELETE", path: "/projects/{projectId}" },
      },
      actors: {
        user: { role: "regular-user", auth: { kind: "login", operationId: "login", usernameEnv: "U", passwordEnv: "UP", tokenPath: "accessToken" } },
        admin: { role: "administrator", auth: { kind: "login", operationId: "login", usernameEnv: "A", passwordEnv: "AP", tokenPath: "accessToken" } },
        nobody: { role: "anonymous", auth: { kind: "none" } },
      },
      fixtures: {
        proj: {
          seed: { operationId: "create", actorRef: "user", input: { name: "qa-{{run.id}}" }, capture: { id: "id" } },
          cleanup: { operationId: "del", actorRef: "user", input: { projectId: "{{fixture.proj.id}}" } },
        },
      },
    });

  beforeAll(async () => {
    server = createDemoServer();
    baseUrl = await listen(server);
  });
  afterAll(() => server.close());

  it("logs actors in, keeps sessions separate, and records secrets for masking", async () => {
    const target = new HttpTarget(config(), { env });
    const user = await target.actors.resolve("user", signal());
    const admin = await target.actors.resolve("admin", signal());
    expect(user.sessionRef).not.toBe(admin.sessionRef);
    expect((await target.registry.execute(user, { operationId: "update", input: { theme: "x" } }, signal())).status).toBe(403);
    expect((await target.registry.execute(admin, { operationId: "update", input: { theme: "x" } }, signal())).status).toBe(200);
    const nobody = await target.actors.resolve("nobody", signal());
    expect((await target.registry.execute(nobody, { operationId: "me", input: {} }, signal())).status).toBe(401);
    expect(target.secrets()).toEqual(expect.arrayContaining(["alice-demo-password", "root-demo-password"]));
    expect(target.secrets().some((s) => /^[0-9a-f]{48}$/.test(s))).toBe(true);
    await target.actors.dispose(user);
    await expect(target.registry.execute(user, { operationId: "me", input: {} }, signal())).rejects.toThrow(/no live session/);
  });

  it("seeds and cleans fixtures, filling path parameters", async () => {
    const target = new HttpTarget(config(), { env });
    const ctx = { runId: "r1", fixtures: {} as Record<string, Record<string, unknown>> };
    ctx.fixtures["proj"] = await target.fixtures.seed("proj", ctx, signal());
    expect(ctx.fixtures["proj"]).toEqual({ id: expect.any(Number) });
    const user = await target.actors.resolve("user", signal());
    const read = await target.registry.execute(user, { operationId: "read", input: { projectId: ctx.fixtures["proj"]!["id"] } }, signal());
    expect(read).toMatchObject({ status: 200, body: { name: "qa-r1" }, request: { method: "GET" } });
    await target.fixtures.cleanup("proj", ctx, signal());
    const gone = await target.registry.execute(user, { operationId: "read", input: { projectId: ctx.fixtures["proj"]!["id"] } }, signal());
    expect(gone.status).toBe(404);
  });

  it("fails actor resolution on wrong or missing credentials", async () => {
    await expect(new HttpTarget(config(), { env: { ...env, UP: "wrong" } }).actors.resolve("user", signal())).rejects.toThrow(/login returned HTTP 401/);
    await expect(new HttpTarget(config(), { env: {} }).actors.resolve("user", signal())).rejects.toThrow(/U is not set/);
  });

  it("rejects GET inputs that map to neither path nor query, and missing path params", async () => {
    const target = new HttpTarget(config(), { env });
    const user = await target.actors.resolve("user", signal());
    await expect(target.registry.execute(user, { operationId: "me", input: { stray: 1 } }, signal())).rejects.toThrow(/not mapped/);
    await expect(target.registry.execute(user, { operationId: "read", input: {} }, signal())).rejects.toThrow(/unresolved/);
  });
});

describe("HttpTarget transport behaviour", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/login" });
        return res.end();
      }
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: "x".repeat(10_000) }));
      }
      if (req.url === "/graphql") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ errors: [{ message: "no", extensions: { code: "FORBIDDEN" } }], data: null }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    baseUrl = await listen(server);
  });
  afterAll(() => server.close());

  const target = (operations: Record<string, unknown>, maxResponseBytes?: number) =>
    new HttpTarget(
      HttpTargetSchema.parse({ schemaVersion: 1, baseUrl, operations, actors: { a: { role: "r", auth: { kind: "none" } } } }),
      { env: {}, ...(maxResponseBytes && { maxResponseBytes }) },
    );

  it("surfaces redirects instead of following them to a login page", async () => {
    const t = target({ op: { method: "GET", path: "/redirect" } });
    const actor = await t.actors.resolve("a", signal());
    expect((await t.registry.execute(actor, { operationId: "op", input: {} }, signal())).status).toBe(302);
  });

  it("caps response bodies and marks them incomplete", async () => {
    const t = target({ op: { method: "GET", path: "/huge" } }, 1_000);
    const actor = await t.actors.resolve("a", signal());
    expect(await t.registry.execute(actor, { operationId: "op", input: {} }, signal())).toMatchObject({ status: 200, bodyComplete: false });
  });

  it("extracts GraphQL error codes and sends variables", async () => {
    const t = target({ op: { method: "POST", path: "/graphql", graphql: { query: "mutation { x }" } } });
    const actor = await t.actors.resolve("a", signal());
    expect(await t.registry.execute(actor, { operationId: "op", input: { id: 1 } }, signal())).toMatchObject({ errorCode: "FORBIDDEN" });
  });

  it("encodes path parameters and keeps query values out of evidence", async () => {
    const t = target({ op: { method: "GET", path: "/items/{id}", query: ["token"] } });
    const actor = await t.actors.resolve("a", signal());
    const res = await t.registry.execute(actor, { operationId: "op", input: { id: "../admin", token: "abc" } }, signal());
    expect((res.body as { url: string }).url).toBe("/items/..%2Fadmin?token=abc");
    expect(res.request).toEqual({ method: "GET", url: "/items/..%2Fadmin?token" });
  });
});
