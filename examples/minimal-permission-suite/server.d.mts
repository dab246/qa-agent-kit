import type { Server } from "node:http";

/** Demo system under test; `bug: true` injects a privilege escalation. */
export function createDemoServer(options?: { bug?: boolean }): Server;
