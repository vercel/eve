import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2026-07-28";

const MCP_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const answered = request.toolResults.some((result) => result.name === "ask_question");
  if (!answered) {
    return {
      toolCalls: [{
        id: "question-1",
        input: {
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
          prompt: "Proceed with the delegated work?",
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
  },
  installDependencies: true,
  name: "mcp-agent-channel",
};

describe("MCP agent channel", () => {
  it(
    "runs a durable input lifecycle through modern and legacy Nitro requests",
    async () => {
      const app = await scenarioApp(MCP_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const started = await callTool(server.url, "alice", "modern", "agent_start", {
          message: "Run the lifecycle.",
        });
        const invocationId = requiredString(started.invocationId, "invocationId");
        const pending = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "input_required",
        ]);
        const requestId = requiredString(
          Object.keys(requiredRecord(pending.inputRequests, "inputRequests"))[0],
          "requestId",
        );

        const hidden = await callToolResult(server.url, "bob", "modern", "agent_get", {
          invocationId,
        });
        expect(hidden.isError).toBe(true);

        const responses = [{ optionId: "yes", requestId }];
        const immediateRetries = await Promise.all([
          callTool(server.url, "alice", "modern", "agent_update", {
            invocationId,
            responses,
          }),
          callTool(server.url, "alice", "modern", "agent_update", {
            invocationId,
            responses,
          }),
        ]);
        expect(immediateRetries).toEqual([
          expect.objectContaining({ invocationId }),
          expect.objectContaining({ invocationId }),
        ]);

        const completed = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "completed",
        ]);
        expect(completed).toMatchObject({ result: "MCP-LIFECYCLE-COMPLETE" });
        await expect(
          callTool(server.url, "alice", "modern", "agent_update", {
            invocationId,
            responses,
          }),
        ).resolves.toMatchObject({ invocationId, status: "completed" });

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
  return await fetch(new URL("/mcp", serverUrl), {
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

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} was not a non-empty string.`);
  }
  return value;
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
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
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

  let url: string;
  try {
    url = await waitForServerUrl(child, () => ({ stderr, stdout }));
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChild(child);
    },
    url,
  };
}

async function waitForServerUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: () => { readonly stderr: string; readonly stdout: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const current = output();
      reject(new Error(`Timed out waiting for eve dev.\n${current.stdout}\n${current.stderr}`));
    }, OPERATION_TIMEOUT_MS);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`eve dev exited before startup (code ${String(code)}, ${String(signal)}).`));
    }
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    inspect();
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
