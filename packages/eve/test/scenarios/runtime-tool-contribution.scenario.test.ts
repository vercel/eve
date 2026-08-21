import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/index.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startMcpStubServer } from "../tui-client/lib/mcp-stub-server.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
} from "./dev-server-descriptors.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const RUNTIME_TOOL_CONTRIBUTION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  name: "runtime-tool-contribution",
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/connections/stub.ts": [
      'import { defineMcpClientConnection } from "eve/connections";',
      'import { always } from "eve/tools/approval";',
      "",
      "export default defineMcpClientConnection({",
      '  description: "Scenario MCP connection.",',
      "  approval: always(),",
      '  url: process.env.RUNTIME_TOOL_MCP_URL ?? "http://127.0.0.1:0/mcp",',
      "});",
      "",
    ].join("\n"),
  },
};

describe("runtime tool contributions", () => {
  it(
    "resumes a contributed connection tool approval in a fresh process",
    async () => {
      const marker = `runtime-contribution-${Date.now()}`;
      const mcp = await startMcpStubServer({ marker });
      const app = await scenarioApp(RUNTIME_TOOL_CONTRIBUTION_DESCRIPTOR);
      const pinnedEnv = {
        RUNTIME_TOOL_MCP_URL: mcp.url,
        VERCEL_DEPLOYMENT_ID: "runtime-tool-contribution",
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
      };
      let server = await startEveDev(app.appRoot, { env: pinnedEnv });

      try {
        const client = new Client({ host: server.url });
        const created = await client.sessions.create({ message: "Hello." });
        await expect(created.response.result()).resolves.toMatchObject({ status: "waiting" });

        const searched = await (
          await created.session.send(
            'Use connection_search with keywords "echo marker" to discover the stub tool.',
          )
        ).result();
        expect(searched.status).toBe("waiting");
        expect(
          searched.events.some(
            (event) =>
              event.type === "action.result" &&
              event.data.result.kind === "tool-result" &&
              event.data.result.toolName === "connection_search" &&
              event.data.status === "completed",
          ),
        ).toBe(true);

        const waiting = await (
          await created.session.send('Use stub__echo_marker with note "cold replay".')
        ).result();
        expect(waiting.status).toBe("waiting");
        expect(waiting.inputRequests).toHaveLength(1);

        const sessionState = created.session.state;
        await server.crash();
        await waitForCondition(async () => {
          try {
            await readFile(join(app.appRoot, ".eve", "dev-server-state.v1.json"));
            return false;
          } catch (error) {
            return error instanceof Error && "code" in error && error.code === "ENOENT";
          }
        }, "The crashed development server did not release its state record.");
        server = await startEveDev(app.appRoot, { env: pinnedEnv });

        const resumedSession = new Client({ host: server.url }).sessions.attach(
          sessionState.sessionId,
          { streamIndex: sessionState.streamIndex },
        );
        const resumed = await (
          await resumedSession.respond([
            {
              optionId: "approve",
              requestId: waiting.inputRequests[0]!.requestId,
            },
          ])
        ).result();
        expect(resumed.status).toBe("waiting");

        const toolResult = resumed.events.find(
          (event) =>
            event.type === "action.result" &&
            event.data.result.kind === "tool-result" &&
            event.data.result.toolName === "stub__echo_marker" &&
            event.data.status === "completed",
        );
        expect(toolResult).toBeDefined();
        if (toolResult?.type !== "action.result" || toolResult.data.result.kind !== "tool-result") {
          throw new Error("Expected the contributed connection tool result.");
        }
        expect(JSON.stringify(toolResult.data.result.output)).toContain(marker);
      } finally {
        await server.stop();
        await mcp.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
