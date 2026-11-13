import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "openinstinct-runtime-"));
const artifacts = join(root, ".eve", "runtime-smoke");

try {
  await cp(join(root, "tests/runtime/fixture"), fixture, { recursive: true });
  // Eve compiles workflow directives from authored tool files, not re-exports.
  // Copy current production source on every run so the fixture cannot drift.
  await mkdir(join(fixture, "agent/tools"), { recursive: true });
  await cp(
    join(root, "agent/tools/run_browser.ts"),
    join(fixture, "agent/tools/run_browser.ts")
  );
  // Validate the production instruction contract against the installed runtime,
  // rather than running the deterministic worker with a fixture-only prompt.
  await cp(
    join(root, "agent/subagents/browser-agent/instructions.md"),
    join(fixture, "agent/subagents/browser-agent/instructions.md")
  );
  await writeFile(
    join(fixture, "agent/instructions.md"),
    [
      await readFile(join(fixture, "agent/instructions.md"), "utf8"),
      await readFile(
        join(root, "agent/instructions/content/worker-coordination.md"),
        "utf8"
      ),
    ].join("\n\n")
  );
  await symlink(
    join(root, "node_modules"),
    join(fixture, "node_modules"),
    "junction"
  );
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "openinstinct-runtime-smoke",
      private: true,
      type: "module",
      dependencies: { eve: "*" },
    })
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@agent/*": [join(root, "agent/*")],
          "@shared/*": [join(root, "shared/*")],
        },
      },
    })
  );
  await mkdir(artifacts, { recursive: true });
  await rm(join(artifacts, "junit.xml"), { force: true });
  const child = spawn(
    join(root, "node_modules/.bin/eve"),
    [
      "eval",
      "--strict",
      "--skip-report",
      "--junit",
      join(artifacts, "junit.xml"),
    ],
    {
      cwd: fixture,
      detached: process.platform !== "win32",
      // This fixture has mock models and no production service credentials or env files.
      /* oxlint-disable eslint/no-restricted-properties, turbo/no-undeclared-env-vars -- standalone subprocess bootstrap forwards only host executable and home paths. */
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "development",
      },
      /* oxlint-enable eslint/no-restricted-properties, turbo/no-undeclared-env-vars */
      stdio: "inherit",
    }
  );
  let interrupted = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  function terminate(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
  function interrupt() {
    interrupted = true;
    terminate("SIGTERM");
    forceStop ??= setTimeout(() => {
      terminate("SIGKILL");
    }, 5_000);
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timeout = setTimeout(interrupt, 180_000);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve(interrupted ? 1 : (code ?? 1));
      });
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceStop);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (existsSync(join(fixture, ".eve/evals"))) {
      await cp(join(fixture, ".eve/evals"), join(artifacts, "evals"), {
        recursive: true,
      });
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
