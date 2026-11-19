import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUPERVISOR_TEST_TIMEOUT_MS,
  waitForSupervisorClose,
  waitForSupervisorLogEntry,
} from "./helpers/supervisor-process";

const temporaryDirectories: string[] = [];
const supervisorTestOptions = { timeout: SUPERVISOR_TEST_TIMEOUT_MS };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

describe("agent eval supervisor", supervisorTestOptions, () => {
  it("runs migrations and the filtered suite against an isolated database", async () => {
    const result = await runSupervisor({
      AI_GATEWAY_API_KEY: "test-gateway-key",
      KERNEL_API_KEY: "real-key-that-must-not-reach-evals",
    });

    expect(result.code).toBe(0);
    const lines = result.commands.trim().split("\n");
    const project = projectFromComposeCommand(lines[0]);
    expect(lines).toEqual([
      `compose --project-name ${project} up --detach --wait postgres`,
      `compose --project-name ${project} port postgres 5432`,
      "pnpm db:migrate postgresql://postgres:postgres@127.0.0.1:49152/open_instinct development unused-by-agent-evals http://127.0.0.1:9 http://127.0.0.1:9",
      "pnpm exec eve eval agent --strict --max-concurrency 1 --tag smoke postgresql://postgres:postgres@127.0.0.1:49152/open_instinct development unused-by-agent-evals http://127.0.0.1:9 http://127.0.0.1:9",
      `compose --project-name ${project} down --volumes`,
    ]);
  });

  it("requires model credentials before starting Docker", async () => {
    const result = await runSupervisor();

    expect(result.code).toBe(1);
    expect(result.commands).toBe("");
    expect(result.stderr).toContain(
      "Agent evals require AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN."
    );
  });

  it.each([
    ["concurrency override", ["--max-concurrency", "8"]],
    ["remote target", ["--url", "https://example.com"]],
    ["different eval path", ["browser"]],
  ])("rejects a %s before starting Docker", async (_description, args) => {
    const result = await runSupervisor(
      { AI_GATEWAY_API_KEY: "test-gateway-key" },
      args
    );

    expect(result.code).toBe(1);
    expect(result.commands).toBe("");
    expect(result.stderr).toContain("Unsupported agent eval argument");
  });

  it("returns a failing eval exit code after stopping the database", async () => {
    const result = await runSupervisor({
      AI_GATEWAY_API_KEY: "test-gateway-key",
      EVAL_EXIT_CODE: "1",
    });

    expect(result.code).toBe(1);
    expect(result.commands.trim().split("\n").at(-1)).toMatch(
      /^compose --project-name open-instinct-evals-[a-f0-9]{8}-[a-f0-9]{8} down --volumes$/u
    );
  });

  it("returns a signal exit code after cleaning up interrupted startup", async () => {
    const result = await runSupervisor({
      AI_GATEWAY_API_KEY: "test-gateway-key",
      EVAL_BLOCK_ACTION: "up",
    });

    expect(result.code).toBe(130);
    const lines = result.commands.trim().split("\n");
    const project = projectFromComposeCommand(lines[0]);
    expect(lines).toEqual([
      `compose --project-name ${project} up --detach --wait postgres`,
      `compose --project-name ${project} down --volumes`,
    ]);
  });

  it("preserves the signal exit code when the eval process is interrupted", async () => {
    const result = await runSupervisor({
      AI_GATEWAY_API_KEY: "test-gateway-key",
      EVAL_BLOCK_ACTION: "eval",
    });

    expect(result.code).toBe(130);
    const lines = result.commands.trim().split("\n");
    const project = projectFromComposeCommand(lines[0]);
    expect(lines).toEqual([
      `compose --project-name ${project} up --detach --wait postgres`,
      `compose --project-name ${project} port postgres 5432`,
      "pnpm db:migrate postgresql://postgres:postgres@127.0.0.1:49152/open_instinct development unused-by-agent-evals http://127.0.0.1:9 http://127.0.0.1:9",
      "pnpm exec eve eval agent --strict --max-concurrency 1 --tag smoke postgresql://postgres:postgres@127.0.0.1:49152/open_instinct development unused-by-agent-evals http://127.0.0.1:9 http://127.0.0.1:9",
      `compose --project-name ${project} down --volumes`,
    ]);
  });
});

function projectFromComposeCommand(command: string | undefined) {
  const project = command?.match(
    /^compose --project-name (open-instinct-evals-[a-f0-9]{8}-[a-f0-9]{8}) /u
  )?.[1];
  if (!project) {
    throw new Error(`Missing Compose project in: ${String(command)}`);
  }
  return project;
}

async function runSupervisor(
  environment: Record<string, string> = {},
  args = ["--tag", "smoke"]
) {
  const directory = await mkdtemp(join(tmpdir(), "open-instinct-evals-"));
  temporaryDirectories.push(directory);
  const logPath = join(directory, "commands.log");
  const dockerPath = join(directory, "docker");
  const pnpmPath = join(directory, "pnpm");
  await Promise.all([
    writeFile(
      dockerPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "$EVAL_SUPERVISOR_LOG"
if [ "$4" = "port" ]; then
  printf '127.0.0.1:49152\n'
fi
if [ "$4" = "\${EVAL_BLOCK_ACTION:-never}" ]; then
  trap 'exit 130' INT TERM HUP
  while true; do /bin/sleep 0.1; done
fi
`
    ),
    writeFile(
      pnpmPath,
      `#!/bin/sh
printf 'pnpm %s %s %s %s %s %s\n' "$*" "$DATABASE_URL" "$NODE_ENV" "$KERNEL_API_KEY" "$KERNEL_BASE_URL" "$BETTER_AUTH_URL" >> "$EVAL_SUPERVISOR_LOG"
if [ "$1" = "exec" ]; then
  if [ "\${EVAL_BLOCK_ACTION:-never}" = "eval" ]; then
    trap 'exit 130' INT TERM HUP
    while true; do /bin/sleep 0.1; done
  fi
  exit "\${EVAL_EXIT_CODE:-0}"
fi
`
    ),
  ]);
  await Promise.all([chmod(dockerPath, 0o755), chmod(pnpmPath, 0o755)]);

  const supervisor = spawn(
    process.execPath,
    [
      new URL("../scripts/run-agent-evals.ts", import.meta.url).pathname,
      ...args,
    ],
    {
      env: {
        EVAL_SUPERVISOR_LOG: logPath,
        NODE_ENV: "test",
        PATH: directory,
        ...environment,
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  supervisor.stderr.setEncoding("utf8");
  let stderr = "";
  supervisor.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = waitForSupervisorClose(supervisor);
  if (environment.EVAL_BLOCK_ACTION) {
    await waitForSupervisorLogEntry(
      logPath,
      ` ${environment.EVAL_BLOCK_ACTION} `
    );
    supervisor.kill("SIGINT");
  }

  return {
    code: await exitCode,
    commands: await readFile(logPath, "utf8").catch(() => ""),
    stderr,
  };
}
