import { spawn } from "node:child_process";
import { join } from "node:path";

import type { HandleMessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;

const TSCONFIG_SOURCE = `${JSON.stringify(
  {
    compilerOptions: {
      allowJs: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2024",
    },
    include: ["agent/**/*"],
  },
  null,
  2,
)}\n`;

const SCHEDULE_CHANNEL_AGENT: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": [
      'import { defineAgent } from "eve";',
      'import { gateway } from "ai";',
      "",
      "export default defineAgent({",
      '  model: gateway("openai/gpt-5.5"),',
      "  // Pin context-window metadata so compile stays credential-free.",
      "  modelContextWindowTokens: 200_000,",
      "});",
      "",
    ].join("\n"),
    "agent/channels/probe.ts": [
      'import { defineChannel, POST } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [POST("/probe", async () => Response.json({ ok: true }))],',
      "  async receive(input, { send }) {",
      '    return send(input.message, { auth: input.auth, continuationToken: "probe" });',
      "  },",
      "});",
      "",
    ].join("\n"),
    "agent/instructions.md": "Probe agent.\n",
    "agent/schedules/digest.ts": [
      'import { defineSchedule } from "eve/schedules";',
      'import probe from "../channels/probe.js";',
      "",
      "export default defineSchedule({",
      '  cron: "0 0 * * *",',
      "  async run({ receive, waitUntil, appAuth }) {",
      "    waitUntil(",
      "      receive(probe, {",
      '        message: "scheduled ping",',
      '        target: { sessionRef: "probe" },',
      "        auth: appAuth,",
      "      }),",
      "    );",
      "  },",
      "});",
      "",
    ].join("\n"),
    "tsconfig.json": TSCONFIG_SOURCE,
  },
  installDependencies: true,
  name: "schedule-channel-model-resolution",
};

interface RunningEveDev {
  readonly output: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("[")
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^[0-9;]*m/, "")))
    .join("");
}

function parseServerUrl(output: string): string | undefined {
  return /server listening at (https?:\/\/\S+)/.exec(stripAnsi(output))?.[1];
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
        // NODE_ENV=test would mock the model and skip the resolution path
        // under test, so run with real resolution.
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let combined = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    combined += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    combined += chunk;
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for eve dev to start.\noutput:\n${combined}`));
    }, 120_000);

    const settle = () => {
      const candidate = parseServerUrl(combined);
      if (candidate !== undefined) {
        clearTimeout(timeout);
        child.stdout.off("data", settle);
        child.stderr.off("data", settle);
        resolve(candidate);
      }
    };

    child.stdout.on("data", settle);
    child.stderr.on("data", settle);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `eve dev exited before listening (code ${String(code)}, signal ${String(signal)}).\noutput:\n${combined}`,
        ),
      );
    });
    settle();
  });

  return {
    output: () => combined,
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

describe("dev model resolution with a run-handler schedule importing a channel", () => {
  it(
    "resolves the source-backed model without a module-map load error",
    async () => {
      const app = await scenarioApp(SCHEDULE_CHANNEL_AGENT);
      const server = await startEveDev(app.appRoot);

      try {
        // No model credentials, so the turn is expected to fail; assert only
        // that it started (not a vacuous pass) and failed past model resolution
        // rather than on the module-map regression.
        const events: HandleMessageStreamEvent[] = [];
        let thrown = "";
        try {
          await sendDevelopmentMessage({
            message: "hello",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
            onEvent: (event) => events.push(event),
          });
        } catch (error) {
          thrown = String(error);
        }

        expect(
          events.length > 0,
          [
            "Expected the dev message route to stream at least one session event.",
            `thrown: ${thrown}`,
            `output:\n${server.output()}`,
          ].join("\n\n"),
        ).toBe(true);

        const combined = `${JSON.stringify(events)}\n${thrown}\n${server.output()}`;
        expect(
          combined.includes("LoadCompiledModuleMapError"),
          `Model resolution hit the dev module-map regression.\n${combined}`,
        ).toBe(false);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
