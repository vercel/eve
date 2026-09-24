import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { CapabilityRuntime } from "#execution/capability-session.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { attachRouteCapabilityRuntime } from "#internal/nitro/routes/channel-route-context.js";
import type { ResolvedSkillDefinition, ResolvedToolDefinition } from "#runtime/types.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { ToolContext } from "#tools/definition.js";
import { toInputSchema } from "#tools/schema.js";
import { mcpCapabilitiesChannel } from "#public/channels/mcp.js";
import type { AuthFn } from "#public/channels/auth.js";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

const allowPrincipal: AuthFn<Request> = async () => principal;

describe("mcpCapabilitiesChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpCapabilitiesChannel({} as never)).toThrow(
      "mcpCapabilitiesChannel requires auth",
    );
  });

  it("registers the capabilities route and the authorization callback routes", () => {
    const channel = mcpCapabilitiesChannel({ auth: allowPrincipal });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /eve/v1/mcp-capabilities",
      "GET /eve/v1/mcp-capabilities/authorize/:name/:attemptId",
      "POST /eve/v1/mcp-capabilities/authorize/:name/:attemptId",
    ]);
  });

  it("answers server/discover and prewarms the session sandbox", async () => {
    const harness = createHarness();
    const discover = await harness.call("server/discover", {}, { session: "v2:parent-1" });
    expect(discover.result).toMatchObject({
      _meta: { "eve.dev/sandbox": "warming" },
      capabilities: { resources: {}, tools: {} },
      instructions: "Answers data questions.",
    });
    await Promise.all(harness.waitUntil.mock.calls.map(([task]) => task));
    expect(harness.sandboxOpens()).toBe(1);

    const again = await harness.call("server/discover", {}, { session: "v2:parent-1" });
    expect(again.result).toMatchObject({ _meta: { "eve.dev/sandbox": "ready" } });

    const keyless = await harness.call("server/discover", {});
    expect(keyless.result).toMatchObject({ _meta: { "eve.dev/sandbox": "none" } });
  });

  it("lists exposed tools with owner and approval metadata", async () => {
    const harness = createHarness();
    const listed = await harness.call("tools/list", {});
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "sandbox_note",
      "explode",
      "deploy",
      "summarize",
      "needs_sign_in",
    ]);
    expect(tools[2]).toMatchObject({
      _meta: { "eve.dev/approval": true, "eve.dev/owner": "d0" },
      inputSchema: { properties: { env: { type: "string" } }, type: "object" },
    });
    expect(tools[0]).toMatchObject({ _meta: { "eve.dev/approval": false } });
  });

  it("runs tools server-side with session identity, auth, and one reused sandbox", async () => {
    const harness = createHarness();
    const first = await harness.callTool("sandbox_note", { text: "hello" }, "v2:parent-1");
    expect(first.result).toMatchObject({
      structuredContent: { principal: "user-1", previous: null, written: "hello" },
    });
    const sessionId = (first.result as { structuredContent: { sessionId: string } })
      .structuredContent.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);

    const second = await harness.callTool("sandbox_note", { text: "again" }, "v2:parent-1");
    expect(second.result).toMatchObject({
      structuredContent: { previous: "hello", sessionId, written: "again" },
    });
    expect(harness.sandboxOpens()).toBe(1);

    const other = await harness.callTool("sandbox_note", { text: "x" }, "v2:parent-2");
    expect(other.result).toMatchObject({ structuredContent: { previous: null } });
    expect(
      (other.result as { structuredContent: { sessionId: string } }).structuredContent.sessionId,
    ).not.toBe(sessionId);
  });

  it("deletes ephemeral sandboxes when no session key is sent", async () => {
    const harness = createHarness();
    await harness.callTool("sandbox_note", { text: "once" });
    await Promise.all(harness.waitUntil.mock.calls.map(([task]) => task));
    expect(harness.sandboxDeletes()).toBe(1);
  });

  it("maps toModelOutput to content, objects to structuredContent, and throws to isError", async () => {
    const harness = createHarness();
    const summarized = await harness.callTool("summarize", { topic: "q3" });
    expect(summarized.result).toMatchObject({
      content: [{ text: "Summary of q3", type: "text" }],
      structuredContent: { rows: 3, topic: "q3" },
    });

    const failed = await harness.callTool("explode", {});
    expect(failed.result).toMatchObject({
      content: [{ text: expect.stringContaining("warehouse unavailable"), type: "text" }],
      isError: true,
    });

    const invalid = await harness.callTool("summarize", { topic: 7 });
    expect(invalid.result).toMatchObject({
      content: [{ text: expect.stringContaining("Invalid arguments for summarize") }],
      isError: true,
    });

    const unknown = await harness.callTool("load_skill", {});
    expect(unknown.result).toMatchObject({ isError: true });
  });

  it("round-trips approval through an input-required result", async () => {
    const harness = createHarness();
    const first = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1");
    const pending = first.result as {
      inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
      requestState: string;
      resultType: string;
    };
    expect(pending.resultType).toBe("input_required");
    expect(pending.inputRequests.approval).toMatchObject({
      method: "elicitation/create",
      params: { mode: "form" },
    });
    expect(harness.deployed).toEqual([]);

    const tampered = await harness.callTool("deploy", { env: "production" }, "v2:parent-1", {
      inputResponses: { approval: { action: "accept", content: { approved: true } } },
      requestState: pending.requestState,
    });
    expect(tampered.result).toMatchObject({ isError: true });
    expect(harness.deployed).toEqual([]);

    const declined = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1", {
      inputResponses: { approval: { action: "decline" } },
      requestState: pending.requestState,
    });
    expect(declined.result).toMatchObject({ isError: true });

    const approved = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1", {
      inputResponses: { approval: { action: "accept", content: { approved: true } } },
      requestState: pending.requestState,
    });
    expect(approved.result).toMatchObject({ content: [{ text: "deployed preview" }] });
    expect(harness.deployed).toEqual(["preview"]);
  });

  it("returns URL elicitation for interactive sign-in and completes it on retry", async () => {
    const harness = createHarness();
    const first = await harness.callTool("needs_sign_in", {}, "v2:parent-1");
    const pending = first.result as {
      inputRequests: Record<string, { params: { mode: string; url: string } }>;
      requestState: string;
    };
    const [request] = Object.values(pending.inputRequests);
    expect(request?.params).toMatchObject({ mode: "url", url: "https://idp.example/authorize" });
    const callbackUrl = harness.lastCallbackUrl();
    expect(callbackUrl).toMatch(
      /^https:\/\/agent\.example\/eve\/v1\/mcp-capabilities\/authorize\/needs_sign_in__inline_auth\/[0-9A-Z]{26}$/,
    );

    const callbackRoute = harness.channel.routes[1]!;
    if (callbackRoute.transport === "websocket") throw new Error("expected HTTP route");
    const [, , , , , name, attemptId] = new URL(callbackUrl!).pathname.split("/");
    const landing = await callbackRoute.handler(new Request(`${callbackUrl}?code=abc`), {
      ...harness.routeArgs(),
      params: { attemptId: attemptId!, name: name! },
    });
    expect(landing.status).toBe(200);

    const retried = await harness.callTool("needs_sign_in", {}, "v2:parent-1", {
      requestState: pending.requestState,
    });
    expect(retried.result).toMatchObject({ content: [{ text: "token:code-abc" }] });
  });

  it("serves skills as resources and rejects traversal", async () => {
    const harness = createHarness();
    const listed = await harness.call("resources/list", {});
    expect(listed.result).toMatchObject({
      resources: [
        {
          _meta: {
            "eve.dev/files": ["references/guide.md"],
            "eve.dev/kind": "skill",
            "eve.dev/owner": "d0",
          },
          description: "Investigate a metric drop.",
          mimeType: "text/markdown",
          name: "triage",
          uri: "skill://d0/triage",
        },
      ],
    });

    const templates = await harness.call("resources/templates/list", {});
    expect(templates.result).toMatchObject({
      resourceTemplates: [{ uriTemplate: "skill://d0/{skill}/{+path}" }],
    });

    const skill = await harness.readResource("skill://d0/triage");
    expect(skill.result).toMatchObject({
      contents: [{ mimeType: "text/markdown", text: "# Triage\nCheck the guide." }],
    });
    const file = await harness.readResource("skill://d0/triage/references/guide.md");
    expect(file.result).toMatchObject({ contents: [{ text: "Step 1: look." }] });

    for (const uri of [
      "skill://d0/triage/../secrets.txt",
      "skill://d0/triage/references/%2E%2E/%2E%2E/etc/passwd",
      "skill://d0/triage/references%2Fguide.md",
      "skill://d0/triage/unlisted.md",
      "skill://sre/triage",
      "skill://d0/missing",
    ]) {
      const rejected = await harness.readResource(uri);
      expect(rejected.error, uri).toMatchObject({ code: -32_602 });
    }
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness() {
  const files = new Map<string, Map<string, string>>();
  let opens = 0;
  let deletes = 0;
  const deployed: string[] = [];
  let callbackUrl: string | undefined;

  const openSandbox = async (sessionId: string): Promise<SandboxAccess> => {
    let opened = false;
    const sandbox = {
      async readTextFile({ path }: { path: string }) {
        return files.get(sessionId)?.get(path) ?? null;
      },
      async writeTextFile({ content, path }: { content: string; path: string }) {
        const sessionFiles = files.get(sessionId) ?? new Map<string, string>();
        sessionFiles.set(path, content);
        files.set(sessionId, sessionFiles);
      },
    };
    return {
      async captureState() {
        return {
          session: opened
            ? { providerName: "memory", state: { sessionId }, stateProtocolVersion: 1 }
            : null,
        };
      },
      async delete() {
        deletes++;
        files.delete(sessionId);
      },
      async get() {
        if (!opened) {
          opened = true;
          opens++;
        }
        return sandbox as never;
      },
      async stop() {},
    };
  };

  const signIn = {
    async completeAuthorization(options: { callback: { params: Record<string, string> } }) {
      return { token: `code-${options.callback.params.code ?? "none"}` };
    },
    async getToken(): Promise<never> {
      throw new ConnectionAuthorizationRequiredError("example");
    },
    principalType: "user",
    async startAuthorization(options: { callbackUrl: string }) {
      callbackUrl = options.callbackUrl;
      return { challenge: { url: "https://idp.example/authorize" } };
    },
  };

  const tools = [
    tool({
      execute: async (input: { text: string }, ctx: ToolContext) => {
        const sandbox = await ctx.getSandbox();
        const previous = await sandbox.readTextFile({ path: "/workspace/note.txt" });
        await sandbox.writeTextFile({ content: input.text, path: "/workspace/note.txt" });
        return {
          previous,
          principal: ctx.session.auth.current?.principalId ?? null,
          sessionId: ctx.session.id,
          written: input.text,
        };
      },
      inputSchema: z.object({ text: z.string() }),
      name: "sandbox_note",
    }),
    tool({
      execute: async () => {
        throw new Error("warehouse unavailable");
      },
      inputSchema: z.object({}),
      name: "explode",
    }),
    tool({
      approval: () => true,
      execute: async (input: { env: string }) => {
        deployed.push(input.env);
        return `deployed ${input.env}`;
      },
      inputSchema: z.object({ env: z.string() }),
      name: "deploy",
    }),
    tool({
      execute: async (input: { topic: string }) => ({ rows: 3, topic: input.topic }),
      inputSchema: z.object({ topic: z.string() }),
      name: "summarize",
      toModelOutput: (output: unknown) => ({
        type: "text",
        value: `Summary of ${(output as { topic: string }).topic}`,
      }),
    }),
    tool({
      execute: async (_input: unknown, ctx: ToolContext) =>
        `token:${(await ctx.getToken(signIn as never)).token}`,
      inputSchema: z.object({}),
      name: "needs_sign_in",
    }),
  ];

  const skills: ResolvedSkillDefinition[] = [
    {
      description: "Investigate a metric drop.",
      fileIndex: ["references/guide.md"],
      logicalPath: "skills/triage/SKILL.md",
      markdown: "# Triage\nCheck the guide.",
      name: "triage",
      sourceId: "skills/triage",
      sourceKind: "markdown",
    },
  ];

  const runtime: CapabilityRuntime = {
    agentName: "d0",
    description: "Answers data questions.",
    hasSandbox: true,
    openSandbox,
    async readSkillFile(skillName, path) {
      return skillName === "triage" && path === "references/guide.md"
        ? new TextEncoder().encode("Step 1: look.")
        : undefined;
    },
    skills,
    tools,
  };

  const channel = mcpCapabilitiesChannel({ auth: allowPrincipal });
  const postRoute = channel.routes[0]!;
  if (postRoute.transport === "websocket") throw new Error("expected HTTP route");
  const handlePost = postRoute.handler;
  const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

  const routeArgs = (): RouteHandlerArgs => {
    const unavailable = () => {
      throw new Error("Route operation is unavailable in this test.");
    };
    return attachRouteCapabilityRuntime(
      {
        attachSession: unavailable,
        from: unavailable,
        params: {},
        requestIp: "127.0.0.1",
        resolveSession: vi.fn(),
        to: unavailable,
        waitUntil,
      },
      async () => runtime,
    );
  };

  let nextId = 1;
  const sessionPrefix = crypto.randomUUID();
  async function call(
    method: string,
    params: Record<string, unknown>,
    options: { readonly name?: string; readonly session?: string } = {},
  ): Promise<{ error?: unknown; result?: unknown }> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (options.name !== undefined) headers["mcp-name"] = options.name;
    // The sandbox cache is process-wide; keep each harness's sessions distinct.
    if (options.session !== undefined) {
      headers["eve-capability-session"] = `${sessionPrefix}:${options.session}`;
    }
    const response = await handlePost(
      new Request("https://agent.example/eve/v1/mcp-capabilities", {
        body: JSON.stringify({
          id: nextId++,
          jsonrpc: "2.0",
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {}, url: {} },
              },
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        }),
        headers,
        method: "POST",
      }),
      routeArgs(),
    );
    return (await response.json()) as { error?: unknown; result?: unknown };
  }

  return {
    call,
    async callTool(
      name: string,
      args: Record<string, unknown>,
      session?: string,
      retry: { inputResponses?: Record<string, unknown>; requestState?: string } = {},
    ) {
      return await call("tools/call", { arguments: args, name, ...retry }, { name, session });
    },
    channel,
    deployed,
    lastCallbackUrl: () => callbackUrl,
    async readResource(uri: string) {
      return await call("resources/read", { uri }, { name: uri });
    },
    routeArgs,
    sandboxDeletes: () => deletes,
    sandboxOpens: () => opens,
    waitUntil,
  };
}

function tool(input: {
  readonly approval?: () => boolean;
  readonly execute: (input: never, ctx: ToolContext) => unknown;
  readonly inputSchema: z.ZodType;
  readonly name: string;
  readonly toModelOutput?: (output: unknown) => unknown;
}): ResolvedToolDefinition {
  return {
    approval: input.approval,
    description: `The ${input.name} tool.`,
    // Authored executors receive the tool context as their second argument.
    execute: ((toolInput: unknown, ctx: unknown) =>
      input.execute(toolInput as never, ctx as ToolContext)) as ResolvedToolDefinition["execute"],
    inputSchema: toInputSchema(input.inputSchema),
    logicalPath: `tools/${input.name}.ts`,
    name: input.name,
    owner: { kind: "application" },
    sourceId: `tools/${input.name}`,
    sourceKind: "module",
    toModelOutput: input.toModelOutput as ResolvedToolDefinition["toModelOutput"],
  };
}
