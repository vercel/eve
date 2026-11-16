import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));

// Scripts that build an app or install the packed eve run first, so the
// shorter scripts fill the remaining slots instead of trailing behind them.
const SLOW_FIRST = [
  "tui-connection-auth-user.ts",
  "tui-packed-install-model.ts",
  "tui-subagents-weather.ts",
];

const tests = (await readdir(root))
  .filter((name) => name.startsWith("tui-") && name.endsWith(".ts"))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

// Each script drives a real terminal UI against its own agent server, so a
// few run at once. `EVE_TUI_CONCURRENCY=1` restores one-at-a-time runs.
const concurrency = Math.max(1, Number(process.env.EVE_TUI_CONCURRENCY ?? 3) || 1);

// Every slot starts its agent servers from its own port range, so scripts
// running together never probe or claim each other's ports.
const PORT_BASE = Number(process.env.PORT ?? 3000);
const PORTS_PER_SLOT = 20;

// The slowest script takes under 40 s in CI; a script still running after this
// is stuck.
const SCRIPT_TIMEOUT_MS = Number(process.env.EVE_TUI_SCRIPT_TIMEOUT_MS ?? 180_000);
const KILL_GRACE_MS = 10_000;

// Smoke tests that use the same app share one build. `startAgentServer` reads
// this directory to build each app once per run and start that `.output`
// afterwards; a lock in the same directory keeps scripts running together from
// building one app twice. A fresh directory per run keeps the reuse from
// outliving the sources it was built from.
const buildStateDir = await mkdtemp(join(tmpdir(), "eve-tui-builds-"));

const startedAt = Date.now();
const results = [];
const queue = [...tests];

await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, (_, slot) => worker(slot)),
);

await rm(buildStateDir, { force: true, recursive: true });

console.log(`\n[tui] ${results.length} smoke tests in ${seconds(Date.now() - startedAt)}:`);
for (const result of results.toSorted((a, b) => b.durationMs - a.durationMs)) {
  const status = result.exitCode === 0 ? "ok    " : "FAILED";
  console.log(`[tui]   ${status} ${seconds(result.durationMs).padStart(7)}  ${result.test}`);
}

const failures = results.filter((result) => result.exitCode !== 0);
if (failures.length > 0) {
  console.error(`[tui] ${failures.length} smoke test(s) failed.`);
  process.exitCode = 1;
}

async function worker(slot) {
  for (let test = queue.shift(); test !== undefined; test = queue.shift()) {
    const file = join(root, test);
    const env = {
      ...process.env,
      EVE_TUI_BUILD_STATE_DIR: buildStateDir,
      PORT: String(PORT_BASE + slot * PORTS_PER_SLOT),
    };
    const buffered = concurrency > 1;
    if (buffered) console.log(`[tui] started ${test}`);
    const testStartedAt = Date.now();
    const { exitCode, output } = await runNode(file, env, buffered);
    const durationMs = Date.now() - testStartedAt;
    results.push({ durationMs, exitCode, test });

    // Output is held until the script ends so concurrent scripts do not
    // interleave; a single slot streams it as before.
    if (buffered) {
      console.log(`\n[tui] node ${file} (${seconds(durationMs)})`);
      process.stdout.write(output);
    }
    if (exitCode !== 0) {
      console.error(`[tui] ${test} failed with exit code ${exitCode}.`);
    }
  }
}

function runNode(file, env, buffered) {
  if (!buffered) console.log(`\n[tui] node ${file}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env,
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));
    // A script that cannot start or is killed by a signal fails with the output
    // it wrote, and the run keeps going so the other scripts and the summary
    // still print.
    child.once("error", (error) => {
      resolve({ exitCode: 1, output: `[tui] ${file} failed to start: ${error.message}\n` });
    });
    // A stuck script is stopped like Ctrl+C would stop it, so it shuts down its
    // agent servers, and is killed if it does not exit; its output still prints.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, SCRIPT_TIMEOUT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      if (timedOut) {
        resolve({
          exitCode: 1,
          output: `${output}\n[tui] ${file} timed out after ${seconds(SCRIPT_TIMEOUT_MS)}.\n`,
        });
        return;
      }
      if (signal !== null) {
        resolve({
          exitCode: 1,
          output: `${output}\n[tui] ${file} exited due to signal ${signal}.\n`,
        });
        return;
      }
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

function rank(name) {
  const index = SLOW_FIRST.indexOf(name);
  return index === -1 ? SLOW_FIRST.length : index;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
