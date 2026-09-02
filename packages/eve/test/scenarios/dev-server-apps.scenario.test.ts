import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";
import {
  fetchAgentInfo,
  hasKnownDevServerFailure,
  readDevelopmentRevision,
  startEveDev,
  waitForCondition,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const require = createRequire(import.meta.url);
const TYPESCRIPT_VERSION = (require("typescript/package.json") as { version: string }).version;

const SCHEDULE_DISPATCH_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/schedules/heartbeat.md": [
      "---",
      'cron: "0 0 * * 0"',
      "---",
      "",
      "Report the weather in Lisbon.",
      "",
    ].join("\n"),
  },
  name: "weather-agent-schedules",
};
const NPM_LAYOUT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  name: "weather-agent-npm",
  packageManager: "npm",
};
const WORKFLOW_TOOL_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/lib/deploy/plan.ts": [
      'import { createHash } from "node:crypto";',
      "",
      "export function describePlan(service: string): string {",
      "  return `deploy ${service}`;",
      "}",
      "",
      "export async function hashPlan(plan: string): Promise<string> {",
      '  "use step";',
      '  return createHash("sha256").update(plan).digest("hex").slice(0, 8);',
      "}",
      "",
    ].join("\n"),
    "agent/tools/deploy_service.ts": [
      'import { defineTool } from "eve/tools";',
      'import { sleep } from "workflow";',
      'import { z } from "zod";',
      'import { describePlan, hashPlan } from "../lib/deploy/plan.ts";',
      "",
      "export default defineTool({",
      '  description: "Deploy a service after planning it durably.",',
      "  inputSchema: z.object({ service: z.string() }),",
      "  async execute({ service }, ctx) {",
      '    "use workflow";',
      "    const plan = describePlan(service);",
      "    const digest = await hashPlan(plan);",
      '    await sleep("10ms");',
      "    return { digest, plan, session: ctx.session.id, tool: ctx.toolName };",
      "  },",
      "});",
      "",
    ].join("\n"),
  },
  name: "weather-agent-workflow-tool",
};
const WORKSPACE_EXTENSION_HMR_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    "@acme/workspace-extension": "workspace:*",
  },
  files: {
    "agent/agent.mjs": 'export default { model: "openai/gpt-5.4-mini" };\n',
    "agent/extensions/workspace.mjs": 'export { default } from "@acme/workspace-extension";\n',
    "agent/instructions.md": "Test workspace extension development.\n",
    "packages/workspace-extension/extension/extension.ts": [
      'import { defineExtension } from "eve/extension";',
      "export default defineExtension();",
      "",
    ].join("\n"),
    "packages/workspace-extension/extension/tools/marker.ts": createWorkspaceExtensionToolSource(
      "workspace extension marker one",
    ),
    "packages/workspace-extension/package.json": `${JSON.stringify(
      {
        name: "@acme/workspace-extension",
        version: "0.0.0",
        type: "module",
        eve: { extension: { source: "extension", dist: "dist/extension" } },
        devDependencies: { typescript: TYPESCRIPT_VERSION },
        peerDependencies: { eve: "*" },
      },
      null,
      2,
    )}\n`,
    "packages/workspace-extension/tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
        },
        include: ["extension/**/*"],
      },
      null,
      2,
    )}\n`,
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  },
  installDependencies: true,
  name: "workspace-extension-hmr",
};

function createWorkspaceExtensionToolSource(description: string): string {
  return [
    'import { defineTool } from "eve/tools";',
    "",
    "export default defineTool({",
    `  description: ${JSON.stringify(description)},`,
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() { return { ok: true }; },",
    "});",
    "",
  ].join("\n");
}

async function workspaceExtensionToolDescription(serverUrl: string): Promise<string | undefined> {
  return (await fetchAgentInfo(serverUrl)).tools.static.find(
    (tool) => tool.name === "workspace__marker",
  )?.description;
}

async function expectWorkspaceExtensionToolDescription(
  serverUrl: string,
  description: string,
): Promise<void> {
  await expect(workspaceExtensionToolDescription(serverUrl)).resolves.toBe(description);
}

describe("eve dev server app layouts", () => {
  it(
    "rebuilds mounted workspace extensions from source and preserves the active dist on failure",
    async () => {
      const app = await scenarioApp(WORKSPACE_EXTENSION_HMR_DESCRIPTOR);
      const sourcePath = join(
        app.appRoot,
        "packages",
        "workspace-extension",
        "extension",
        "tools",
        "marker.ts",
      );
      const distPath = join(
        app.appRoot,
        "packages",
        "workspace-extension",
        "dist",
        "extension",
        "tools",
        "marker.mjs",
      );
      expect(existsSync(distPath)).toBe(false);

      const server = await startEveDev(app.appRoot);

      try {
        expect(existsSync(distPath)).toBe(true);
        await expectWorkspaceExtensionToolDescription(server.url, "workspace extension marker one");
        const initialRevision = await readDevelopmentRevision(server.url);

        await writeFile(
          sourcePath,
          `${createWorkspaceExtensionToolSource("rejected marker")}\nconst invalid: string = 1;\n`,
        );
        await waitForCondition(
          () => `${server.stdout()}\n${server.stderr()}`.includes("rebuild failed"),
          () =>
            `Workspace extension build did not fail.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );

        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expectWorkspaceExtensionToolDescription(server.url, "workspace extension marker one");
        await expect(readFile(distPath, "utf8")).resolves.toContain(
          "workspace extension marker one",
        );

        await writeFile(
          sourcePath,
          createWorkspaceExtensionToolSource("workspace extension marker two"),
        );
        await waitForCondition(
          async () =>
            (await workspaceExtensionToolDescription(server.url)) ===
            "workspace extension marker two",
          () =>
            `Workspace extension edit was not published.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );

        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "dispatches an authored schedule through the dev route on its generation",
    async () => {
      const app = await scenarioApp(SCHEDULE_DISPATCH_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL("/eve/v1/dev/schedules/heartbeat", server.url), {
          method: "POST",
        });
        const body = (await response.json()) as {
          scheduleId?: string;
          sessionIds?: readonly string[];
        };
        expect(
          response.status,
          [
            `Expected the dev schedule dispatch route to succeed: ${JSON.stringify(body)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(body.scheduleId).toBe("heartbeat");
        expect(body.sessionIds).toHaveLength(1);

        const unknown = await fetch(new URL("/eve/v1/dev/schedules/missing", server.url), {
          method: "POST",
        });
        expect(unknown.status).toBe(404);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "runs an authored workflow tool through the development server",
    async () => {
      const app = await scenarioApp(WORKFLOW_TOOL_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const messageResult = await sendDevelopmentMessage({
          message: 'Run deploy_service with service "api"',
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        const results = messageResult.events.filter((event) => event.type === "action.result");
        const outputs = results.map((event) => JSON.stringify(event.data));
        expect(
          outputs.some((output) => output.includes('"plan":"deploy api"')),
          [
            "Expected the workflow tool's return value to settle the tool call.",
            `events:\n${messageResult.events.map((event) => event.type).join(",")}`,
            `results:\n${outputs.join("\n")}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        expect(outputs.some((output) => output.includes('"tool":"deploy_service"'))).toBe(true);
        expect(messageResult.events.some((event) => event.type === "message.completed")).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "serves an npm-installed app with hoisted real-directory dependencies",
    async () => {
      const app = await scenarioApp(NPM_LAYOUT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const messageResult = await sendDevelopmentMessage({
          message: "What's the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected the npm-installed dev server to complete a streamed turn.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
