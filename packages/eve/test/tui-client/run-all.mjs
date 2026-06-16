import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const tests = (await readdir(root))
  .filter((name) => name.startsWith("tui-") && name.endsWith(".ts"))
  .sort();

let failures = 0;
for (const test of tests) {
  const file = join(root, test);
  console.log(`\n[tui] node ${file}`);
  const exitCode = await runNode(file);
  if (exitCode !== 0) {
    failures += 1;
    console.error(`[tui] ${test} failed with exit code ${exitCode}.`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}

function runNode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: "inherit" });
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
