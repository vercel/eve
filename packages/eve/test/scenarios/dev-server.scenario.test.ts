import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries(
    Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
      ([path]) => !path.startsWith("agent/channels/"),
    ),
  ),
};

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevBundlingFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevBundlingFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known generated dev bundle import failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

describe("eve dev server", () => {
  it(
    "boots the packaged development server and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        await wait(1_000);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
