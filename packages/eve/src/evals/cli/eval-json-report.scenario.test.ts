import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const PAYLOAD_SIZE = 2_000_000;
const createScratchDirectory = useTemporaryDirectories();

it("writes the complete JSON report to piped stdout", async () => {
  const appRoot = await createScratchDirectory("eve-eval-json-report-");
  await createEvalApp(appRoot);

  const server = createEvalTargetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const result = await runEvalCli(appRoot, `http://127.0.0.1:${address.port}`);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as {
      results: [{ result: { logs: [string] } }];
    };
    expect(report.results[0].result.logs[0]).toHaveLength(PAYLOAD_SIZE);
  } finally {
    await closeServer(server);
  }
});

it.each([
  { name: "the pipe consumer closes early", mode: "close-early" as const },
  { name: "its descriptor is closed", mode: "closed" as const },
])("still exits when stdout $name", async ({ mode }) => {
  const appRoot = await createScratchDirectory("eve-eval-json-closed-pipe-");
  await createEvalApp(appRoot);

  const server = createEvalTargetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const result = await runEvalCli(appRoot, `http://127.0.0.1:${address.port}`, mode);

    expect(result.exitCode, result.stderr).toBe(0);
  } finally {
    await closeServer(server);
  }
});

async function createEvalApp(appRoot: string): Promise<void> {
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, "evals"), { recursive: true });
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "eval-json-report-test", private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(appRoot, "agent", "agent.js"),
    'export default { model: "openai/gpt-5.4" };\n',
  );
  await writeFile(
    join(appRoot, "evals", "large-report.eval.ts"),
    [
      "export default {",
      '  _tag: "EveEval",',
      "  async test(t) {",
      `    t.log("A".repeat(${PAYLOAD_SIZE}));`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(appRoot, "evals", "evals.config.ts"),
    'export default { _tag: "EveEvalConfig" };\n',
  );
}

function createEvalTargetServer(): Server {
  const info = createTestAgentInfoResult({ name: "eval-json-report-test" });
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/eve/v1/health") {
      response.end(JSON.stringify({ ok: true, status: "ready", workflowId: "test-workflow" }));
      return;
    }
    if (request.url === "/eve/v1/info") {
      response.end(JSON.stringify(info));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
}

async function runEvalCli(
  appRoot: string,
  targetUrl: string,
  stdoutMode: "collect" | "close-early" | "closed" = "collect",
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const cliEntrypointUrl = new URL("../../../dist/src/cli/run.js", import.meta.url).href;
  const closeStdout =
    stdoutMode === "closed" ? 'const { closeSync } = await import("node:fs"); closeSync(1);' : "";
  const script = `${closeStdout} const { runCli } = await import(${JSON.stringify(cliEntrypointUrl)}); await runCli(["eval", "--json", "--url", ${JSON.stringify(targetUrl)}]);`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: appRoot,
    env: { ...process.env, EVE_EVAL_AUTH_TOKEN: "test-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  if (stdoutMode === "close-early") {
    child.stdout.destroy();
  } else {
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  }
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("eve eval did not exit after stdout closed"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}
