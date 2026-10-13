// End-to-end demo: starts the example app, runs the full QA pipeline against it
// through the real CLI and HTTP adapter, and prints the gate decision.
//   npm run demo        → GO on a correct app
//   npm run demo:bug    → NO_GO: injected privilege escalation is caught (V2)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDemoServer } from "../examples/minimal-permission-suite/server.mjs";
import { main } from "../dist/cli/main.js";

const bug = process.argv.includes("--bug");
const root = fileURLToPath(new URL("..", import.meta.url));
const server = createDemoServer({ bug });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Demo-only credentials for the fake app. Real runs read these from the CI secret store.
Object.assign(process.env, {
  QA_TARGET_URL: `http://127.0.0.1:${port}`,
  QA_REGULAR_USER: "alice",
  QA_REGULAR_PASSWORD: "alice-demo-password",
  QA_OTHER_USER: "bob",
  QA_OTHER_PASSWORD: "bob-demo-password",
  QA_ADMIN_USER: "root",
  QA_ADMIN_PASSWORD: "root-demo-password",
});

let commit;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  commit = "0000000000000000000000000000000000000000";
}

console.error(`demo app on port ${port}${bug ? " with an injected privilege-escalation bug" : ""}`);
const code = await main([
  "run",
  "--config", `${root}/examples/minimal-permission-suite/qa-agent-kit.yaml`,
  "--ci", "local",
  "--commit", commit,
  "--out", `${root}/artifacts/demo`,
]);
server.close();
process.exitCode = code;
