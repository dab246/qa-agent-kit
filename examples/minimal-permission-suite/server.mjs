// Demo system under test for the example suite. Test-only: in-memory, fake accounts.
// `bug: true` injects a privilege escalation (regular users may update admin settings).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const ACCOUNTS = {
  alice: { password: "alice-demo-password", role: "regular-user" },
  bob: { password: "bob-demo-password", role: "regular-user" },
  root: { password: "root-demo-password", role: "administrator" },
};

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

const readJson = async (req) => {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65_536) throw new Error("body too large");
  }
  return text ? JSON.parse(text) : {};
};

// Anchored, bounded digit run: linear time.
const PROJECT_PATH = /^\/projects\/(\d{1,9})$/;

export function createDemoServer({ bug = false } = {}) {
  const state = { sessions: new Map(), projects: new Map(), nextId: 1, settings: { theme: "light", retentionDays: 30 } };
  const isAdmin = (user) => user.role === "administrator";

  const login = async (req, res) => {
    const { username, password } = await readJson(req);
    const account = ACCOUNTS[username];
    if (!account || account.password !== password) return send(res, 401, { error: "invalid credentials" });
    const token = randomBytes(24).toString("hex");
    state.sessions.set(token, { username, role: account.role });
    return send(res, 200, { accessToken: token });
  };

  const authenticated = {
    "GET /settings/me": (req, res, user) => send(res, 200, { username: user.username, theme: state.settings.theme }),
    "PUT /admin/settings": async (req, res, user) => {
      const body = await readJson(req);
      if (!isAdmin(user) && !bug) return send(res, 403, { error: "forbidden" });
      Object.assign(state.settings, body);
      return send(res, 200, { settings: state.settings });
    },
    "POST /projects": async (req, res, user) => {
      const body = await readJson(req);
      const project = { id: state.nextId++, name: String(body.name ?? "project"), owner: user.username };
      state.projects.set(project.id, project);
      return send(res, 201, project);
    },
  };

  const projectById = (req, res, user, id) => {
    const project = state.projects.get(id);
    if (!project) return send(res, 404, { error: "not found" });
    if (project.owner !== user.username && !isAdmin(user)) return send(res, 403, { error: "forbidden" });
    if (req.method === "GET") return send(res, 200, project);
    if (req.method !== "DELETE") return send(res, 404, { error: "not found" });
    state.projects.delete(project.id);
    return send(res, 204);
  };

  const userOf = (req) => {
    const auth = req.headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? state.sessions.get(auth.slice(7)) : undefined;
  };

  const route = async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "POST" && pathname === "/auth/login") return login(req, res);
    const user = userOf(req);
    if (!user) return send(res, 401, { error: "unauthenticated" });
    const handler = authenticated[`${req.method} ${pathname}`];
    if (handler) return handler(req, res, user);
    const match = PROJECT_PATH.exec(pathname);
    return match ? projectById(req, res, user, Number(match[1])) : send(res, 404, { error: "not found" });
  };

  return createServer((req, res) => route(req, res).catch(() => send(res, 400, { error: "bad request" })));
}
