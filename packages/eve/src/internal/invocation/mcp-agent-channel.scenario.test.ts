import { describe, expect, it } from "vitest";

import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import {
  requiredRecord,
  requiredString,
  startScenarioEveDev,
} from "#internal/testing/scenario-eve-dev.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2026-07-28";

const MCP_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const prompt = JSON.stringify(request.messages);
  if (prompt.includes("MCP-FAILURE-PROBE")) {
    throw new Error("MCP-FAILURE-PROBE: provider rejected the request.");
  }
  const answered = request.toolResults.some((result) => result.name === "ask_question");
  if (!answered) {
    return {
      toolCalls: [{
        id: "question-1",
        input: {
          options: [
            { description: "Continue the delegated work.", label: "Yes" },
            { description: "Stop before the delegated work.", label: "No" },
          ],
          question: "Proceed with the delegated work?",
        },
        name: "ask_question",
      }],
    };
  }
  return "MCP-LIFECYCLE-COMPLETE";
});

export default defineAgent({
  description: "Exercises the durable MCP invocation lifecycle.",
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/mcp.ts": `import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    return principalId === null
      ? null
      : { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
    "agent/tools/ask_question.ts":
      'import { askQuestion } from "eve/tools/ask_question";\n\nexport default askQuestion;\n',
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "mcp-agent-channel",
};

describe("MCP agent channel", () => {
  it(
    "runs a durable input lifecycle through modern and legacy Nitro requests",
    async () => {
      const app = await scenarioApp(MCP_AGENT_DESCRIPTOR);
      const server = await startScenarioEveDev(app.appRoot);

      try {
        const started = await callTool(server.url, "alice", "modern", "agent_start", {
          message: "Run the lifecycle.",
        });
        const invocationId = requiredString(started.invocationId, "invocationId");
        const pending = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "input_required",
        ]);
        const interactionId = requiredString(
          Object.keys(requiredRecord(pending.interactions, "interactions"))[0],
          "interactionId",
        );

        const hidden = await callToolResult(server.url, "bob", "modern", "agent_get", {
          invocationId,
        });
        expect(hidden.isError).toBe(true);

        const responses = [{ interactionId, optionId: "Yes" }];
        await expect(
          callTool(server.url, "alice", "modern", "agent_update", {
            invocationId,
            responses,
          }),
        ).resolves.toMatchObject({ invocationId });

        const completed = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "completed",
        ]);
        expect(completed).toMatchObject({ result: "MCP-LIFECYCLE-COMPLETE" });
        await initializeLegacy(server.url, "alice");
        const legacyStarted = await callTool(server.url, "alice", "legacy", "agent_start", {
          message: "Cancel this lifecycle.",
        });
        const legacyInvocationId = requiredString(legacyStarted.invocationId, "invocationId");
        await pollInvocation(server.url, "alice", "legacy", legacyInvocationId, ["input_required"]);
        await expect(
          callTool(server.url, "alice", "legacy", "agent_cancel", {
            invocationId: legacyInvocationId,
          }),
        ).resolves.toMatchObject({ invocationId: legacyInvocationId });
        await expect(
          pollInvocation(server.url, "alice", "legacy", legacyInvocationId, ["cancelled"]),
        ).resolves.toMatchObject({ status: "cancelled" });

        const failing = await callTool(server.url, "alice", "modern", "agent_start", {
          message: "Trigger MCP-FAILURE-PROBE.",
        });
        const failingInvocationId = requiredString(failing.invocationId, "invocationId");
        const failed = await pollInvocation(server.url, "alice", "modern", failingInvocationId, [
          "failed",
        ]);
        const failure = requiredRecord(failed.error, "error");
        expect(typeof failure.message).toBe("string");
        expect((failure.message as string).length).toBeGreaterThan(0);
        expect(requiredRecord(failure.data, "error.data")).toMatchObject({
          runId: failingInvocationId,
        });
        const serialized = JSON.stringify(failed);
        expect(serialized).not.toMatch(/\n\s+at /);
        expect(serialized).not.toContain("stack");
        expect(serialized.length).toBeLessThan(4_096);

        const unknown = await callToolResult(server.url, "alice", "modern", "agent_get", {
          invocationId: "does-not-exist",
        });
        expect(unknown.isError).toBe(true);
        const notPending = await callToolResult(server.url, "alice", "modern", "agent_update", {
          invocationId,
          responses: [{ interactionId: "stale", optionId: "yes" }],
        });
        expect(notPending.isError).toBe(true);
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

type McpEra = "legacy" | "modern";

async function callTool(
  serverUrl: string,
  principal: string,
  era: McpEra,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await callToolResult(serverUrl, principal, era, name, args);
  if (result.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
  }
  return requiredRecord(result.structuredContent, `${name}.structuredContent`);
}

async function callToolResult(
  serverUrl: string,
  principal: string,
  era: McpEra,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await mcpRequest(serverUrl, principal, era, "tools/call", {
    arguments: args,
    name,
  });
  const envelope = requiredRecord(await readJsonRpcResponse(response), "JSON-RPC envelope");
  return requiredRecord(requiredRecord(envelope.result, "result"), "tool result");
}

async function initializeLegacy(serverUrl: string, principal: string): Promise<void> {
  const response = await mcpRequest(serverUrl, principal, "legacy", "initialize", {
    capabilities: {},
    clientInfo: { name: "eve-scenario", version: "0.0.0" },
    protocolVersion: "2025-11-25",
  });
  expect(response.ok).toBe(true);
}

async function pollInvocation(
  serverUrl: string,
  principal: string,
  era: McpEra,
  invocationId: string,
  statuses: readonly string[],
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const invocation = await callTool(serverUrl, principal, era, "agent_get", { invocationId });
    if (typeof invocation.status === "string" && statuses.includes(invocation.status)) {
      return invocation;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${statuses.join(" or ")} on ${invocationId}.`);
}

async function mcpRequest(
  serverUrl: string,
  principal: string,
  era: McpEra,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const modernMeta =
    era === "modern"
      ? {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "eve-scenario", version: "0.0.0" },
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          },
        }
      : {};
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-test-principal": principal,
  };
  if (era === "modern") {
    headers["mcp-method"] = method;
    headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
  }
  return await fetch(new URL("/eve/v1/mcp", serverUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: { ...params, ...modernMeta },
    }),
    headers,
    method: "POST",
  });
}

async function readJsonRpcResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP response did not contain an SSE data event.");
  return JSON.parse(data.slice("data: ".length));
}
