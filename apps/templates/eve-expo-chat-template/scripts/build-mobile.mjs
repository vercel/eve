import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const app = fileURLToPath(new URL("../apps/mobile/", import.meta.url));
const hasCommit =
  spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" }).status === 0;
const args = process.argv.slice(2);
if (
  !args.includes("--profile") &&
  !args.includes("-e") &&
  !args.some((arg) => arg.startsWith("--profile="))
)
  args.push("--profile", "preview");
const child = spawn("npx", ["--yes", "eas-cli@25.3.0", "build", ...args], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, ...(!hasCommit ? { EAS_NO_VCS: "1", EAS_PROJECT_ROOT: root } : {}) },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
