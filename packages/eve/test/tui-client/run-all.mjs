import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const tests = (await readdir(root))
  .filter((name) => name.startsWith("tui-") && name.endsWith(".ts"))
  .sort();

// Four smoke tests use the same built app. `startAgentServer` reads this
// directory to build each app once per run and start that `.output` afterwards.
// A fresh directory per run keeps the reuse from outliving the sources it was
// built from.
const buildStateDir = await mkdtemp(join(tmpdir(), "eve-tui-builds-"));

let failures = 0;
for (const test of tests) {
  const file = join(root, test);
  console.log(`\n[tui] node ${file}`);
  const exitCode = await runNode(file, { ...process.env, EVE_TUI_BUILD_STATE_DIR: buildStateDir });
  if (exitCode !== 0) {
    failures += 1;
    console.error(`[tui] ${test} failed with exit code ${exitCode}.`);
  }
}

await rm(buildStateDir, { force: true, recursive: true });

if (failures > 0) {
  process.exitCode = 1;
}

function runNode(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${file} exited due to signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
