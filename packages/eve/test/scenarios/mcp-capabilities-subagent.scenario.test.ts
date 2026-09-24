import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const MCP_PROTOCOL_VERSION = "2026-07-28";

const SUBAGENT_CAPABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Root agent that is never prompted in this scenario.",
  model: mockModel(() => "ROOT-SHOULD-NOT-RUN"),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/mcp-capabilities.ts": `import { mcpCapabilitiesChannel } from "eve/channels/mcp";

export default mcpCapabilitiesChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    return principalId === null
      ? null
      : { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
    "agent/subagents/reviewer/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Reviews pasted prose.",
  model: mockModel((request) => {
    const prompt = JSON.stringify(request.messages);
    if (!prompt.includes("PASTED-DRAFT")) return "MISSING-CALLER-MESSAGE";
    const answered = request.toolResults.some((result) => result.name === "ask_question");
    if (!answered) {
      return {
        toolCalls: [{
          id: "question-1",
          input: {
            options: [
              { description: "Review it as a changelog.", label: "Changelog" },
              { description: "Review it as a blog post.", label: "Blog" },
            ],
            question: "Which content type is the draft?",
          },
          name: "ask_question",
        }],
      };
    }
    return "SUBAGENT-REVIEW-COMPLETE";
  }),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/subagents/reviewer/tools/ask_question.ts": `import { askQuestion } from "eve/tools/ask_question";

export default askQuestion();
`,
    "agent/subagents/coordinator/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Hands the scan to its own scanner subagent in the background.",
  model: mockModel((request) => {
    const messages = JSON.stringify(request.messages);
    if (messages.includes("NESTED-SCANNER-RESULT")) return "COORDINATOR-FINAL: NESTED-SCANNER-RESULT";
    if (request.toolResults.some((result) => result.name === "scanner")) {
      return "COORDINATOR-INTERIM-ACK";
    }
    return { toolCalls: [{ id: "scan-1", input: { message: "Scan the draft." }, name: "scanner" }] };
  }),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/subagents/coordinator/subagents/scanner/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Scans a draft.",
  model: mockModel(() => "NESTED-SCANNER-RESULT"),
  modelContextWindowTokens: 32_000,
});
`,
  },
  installDependencies: true,
  name: "mcp-capabilities-subagent",
};

describe("mcpCapabilitiesChannel subagents", () => {
  it(
    "runs declared subagents to completion, relaying questions and waiting out nested work",
    async () => {
      const app = await scenarioApp(SUBAGENT_CAPABILITY_DESCRIPTOR);
      // Run the authored mock models instead of eve dev's default model stand-in.
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const listed = await rpc(server.url, "alice", "tools/list", {});
        const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
        expect(tools.find((tool) => tool.name === "reviewer")).toMatchObject({
          _meta: { "eve.dev/kind": "subagent" },
          inputSchema: { required: ["message"] },
        });

        const args = { message: "Review PASTED-DRAFT for tone." };
        const pending = (await callTool(server.url, "alice", args)) as {
          inputRequests: Record<string, { params: Record<string, unknown> }>;
          requestState: string;
          resultType: string;
        };
        expect(pending.resultType).toBe("input_required");
        const [[requestId, request]] = Object.entries(pending.inputRequests) as [
          [string, { params: { message: string; requestedSchema: Record<string, unknown> } }],
        ];
        expect(request.params.message).toBe("Which content type is the draft?");
        const optionIds = (
          request.params.requestedSchema as { properties: { optionId: { enum: string[] } } }
        ).properties.optionId.enum;
        expect(optionIds).toHaveLength(2);

        const foreign = await callTool(server.url, "bob", args, {
          inputResponses: {
            [requestId]: { action: "accept", content: { optionId: optionIds[0] } },
          },
          requestState: pending.requestState,
        });
        expect(foreign).toMatchObject({ isError: true });

        const completed = await callTool(server.url, "alice", args, {
          inputResponses: {
            [requestId]: { action: "accept", content: { optionId: optionIds[0] } },
          },
          requestState: pending.requestState,
        });
        expect(completed).toMatchObject({
          content: [{ text: "SUBAGENT-REVIEW-COMPLETE", type: "text" }],
        });

        // The coordinator's first turn yields to its background scanner; the call returns the
        // answer written after that nested work settles, not the interim acknowledgement.
        const coordinated = await callTool(
          server.url,
          "alice",
          { message: "Coordinate a scan of PASTED-DRAFT." },
          {},
          "coordinator",
        );
        expect(coordinated).toMatchObject({
          content: [{ text: "COORDINATOR-FINAL: NESTED-SCANNER-RESULT", type: "text" }],
        });
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          {
            cause: error,
          },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function callTool(
  serverUrl: string,
  principal: string,
  args: Readonly<Record<string, unknown>>,
  retry: Readonly<Record<string, unknown>> = {},
  name = "reviewer",
): Promise<unknown> {
  const response = await rpc(serverUrl, principal, "tools/call", {
    arguments: args,
    name,
    ...retry,
  });
  return response.result;
}

async function rpc(
  serverUrl: string,
  principal: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ readonly error?: unknown; readonly result?: unknown }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "eve-capability-session": "scenario-parent",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "x-test-principal": principal,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  const response = await fetch(new URL("/eve/v1/mcp-capabilities", serverUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
          "io.modelcontextprotocol/clientInfo": { name: "eve-scenario", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    }),
    headers,
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`);
  return JSON.parse(body) as { error?: unknown; result?: unknown };
}
