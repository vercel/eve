import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createEveDevDispatchSchedulePath } from "../../src/protocol/routes.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";

/**
 * Pins vercel/eve#311: `POST /eve/v1/dev/schedules/:id` 500ing with
 *
 *     Cannot find module '<projectRoot>/src/internal/authored-module-map-loader.ts'
 *     imported from '<projectRoot>/.eve/nitro/dev/index.mjs'
 *
 * Pre-fix, `dispatchScheduleInDev` re-derived its compiled-artifacts source
 * (and artifacts config) via `resolvePackageSourceFilePath` at request time,
 * from code Nitro had already bundled into `.eve/nitro/dev/index.mjs`. That
 * function locates eve's own package root by walking up from the *currently
 * executing module's* directory looking for an ancestor literally named
 * `dist` — a walk that only succeeds when the code runs unbundled straight
 * out of `node_modules/eve/dist`. Every other Nitro route sidesteps this by
 * resolving the path once in the unbundled host CLI process and baking the
 * literal into the virtual handler; this route was the one place that
 * didn't, so it silently resolved against the *app's* package root instead
 * of eve's the moment Nitro bundled it. A unit test cannot reproduce this —
 * it only manifests once Nitro has actually bundled the route — so this
 * spawns a real `eve dev` against an installed (tarball) `eve`, the same
 * shape a real user's `node_modules/eve` takes.
 */

const SCHEDULE_AGENT_SOURCE = `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
});
`;

const SCHEDULE_TOOL_SOURCE = `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Record that the heartbeat schedule ran.",
  inputSchema: z.object({
    note: z.string(),
  }),
  async execute(input) {
    return \`heartbeat-ok:\${input.note}\`;
  },
});
`;

const SCHEDULE_SOURCE = `import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 0 * * *",
  markdown: "Call the \`record-heartbeat\` tool exactly once with note 'cron-tick'.",
});
`;

const SCHEDULE_DISPATCH_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    zod: "^4.3.6",
  },
  files: {
    "agent/agent.ts": SCHEDULE_AGENT_SOURCE,
    "agent/instructions.md": "You are a precise assistant.\n",
    "agent/schedules/heartbeat.ts": SCHEDULE_SOURCE,
    "agent/tools/record-heartbeat.ts": SCHEDULE_TOOL_SOURCE,
  },
  installDependencies: true,
  name: "dev-schedule-dispatch",
};

const DEV_SERVER_SCENARIO_TIMEOUT_MS = 180_000;
const scenarioApp = useScenarioApp();

function stripAnsi(text: string): string {
  return text
    .split("[")
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^[0-9;]*m/, "")))
    .join("");
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));
  return match?.[1];
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => { readonly stderr: string; readonly stdout: string };
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
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const url = parseServerUrl(input.getOutput().stdout);
      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      settleReject(
        new Error(
          `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
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

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
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
        // Activates the deterministic mock-model adapter so a dispatched
        // schedule's turn completes without real model credentials.
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
    getOutput: () => ({ stderr, stdout }),
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

describe("eve dev schedule dispatch route", () => {
  it(
    "dispatches a compiled schedule instead of 500ing on the authored module map loader path",
    async () => {
      const app = await scenarioApp(SCHEDULE_DISPATCH_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(
          new URL(createEveDevDispatchSchedulePath("heartbeat"), server.url),
          { method: "POST" },
        );
        const responseText = await response.text();

        expect(
          response.status,
          [
            "Expected the dev schedule dispatch route to return 200, not 500.",
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);

        // Regression pin for the exact vercel/eve#311 failure mode.
        expect(responseText).not.toContain("authored-module-map-loader");
        expect(responseText).not.toContain("Cannot find module");

        const body = JSON.parse(responseText) as {
          scheduleId: string;
          sessionIds: readonly string[];
        };
        expect(body.scheduleId).toBe("heartbeat");
        expect(body.sessionIds.length).toBeGreaterThan(0);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
