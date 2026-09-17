import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { a2aResult, callA2A, discoverA2AAgent } from "#runtime/a2a/client.js";
import type { ToolContext } from "#tools/definition.js";
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const unavailable = () => {
    throw new Error("Unavailable in this test");
  };
  return {
    toolName: "planner",
    callId: "call",
    abortSignal: new AbortController().signal,
    session: {
      id: "session",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 1 },
    },
    getSandbox: unavailable,
    getSkill: unavailable,
    getToken: unavailable,
    requireAuth: unavailable,
    ...overrides,
  };
}
const request = vi.fn();
vi.mock("#execution/web-fetch/request.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestPublicUrl: (...args: unknown[]) => request(...args),
}));
const card = (url: string) => ({
  name: "Planner",
  description: "Plans trips",
  version: "1.0.0",
  supportedInterfaces: [
    { url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "travel" },
  ],
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "planning", name: "Planning", description: "Plans trips", tags: [] }],
});
const definition = () => ({
  description: "Planner",
  url: `https://agent-${crypto.randomUUID()}.example`,
});
beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("A2A client", () => {
  it("discovers anonymously and chooses JSONRPC in card preference order", async () => {
    const agent = definition();
    request.mockResolvedValue(
      Response.json({
        ...card(`${agent.url}/rpc`),
        supportedInterfaces: [
          { url: `${agent.url}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" },
          ...card(`${agent.url}/rpc`).supportedInterfaces,
        ],
      }),
    );
    const endpoint = await discoverA2AAgent({
      ...agent,
      auth: { getToken: vi.fn() },
      headers: { "x-api-key": "secret" },
    });
    expect(endpoint).toMatchObject({ url: `${agent.url}/rpc`, tenant: "travel" });
    expect(request).toHaveBeenCalledWith(
      `${agent.url}/.well-known/agent-card.json`,
      expect.objectContaining({ headers: { accept: "application/json" }, redirect: "manual" }),
    );
  });
  it("rejects unapproved interface origins and required extensions before auth", async () => {
    const agent = definition();
    request.mockImplementation(async () => Response.json(card("https://unapproved.example/rpc")));
    await expect(discoverA2AAgent(agent)).rejects.toThrow("not approved");
    await expect(
      discoverA2AAgent({ ...agent, allowedInterfaceOrigins: ["https://unapproved.example"] }),
    ).resolves.toMatchObject({ url: "https://unapproved.example/rpc" });
    request.mockImplementation(async () =>
      Response.json({
        ...card(`${agent.url}/rpc`),
        capabilities: { extensions: [{ uri: "https://example.com/extension", required: true }] },
      }),
    );
    await expect(discoverA2AAgent(agent)).rejects.toThrow("unsupported A2A extension");
  });
  it("revalidates cards and fails closed when a task's interface contract changes", async () => {
    const agent = definition();
    request.mockResolvedValueOnce(
      Response.json(card(`${agent.url}/rpc`), {
        headers: { etag: '"one"', "cache-control": "max-age=0" },
      }),
    );
    const pinned = await discoverA2AAgent(agent);
    request.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { "cache-control": "max-age=0" } }),
    );
    await expect(discoverA2AAgent(agent, pinned)).resolves.toEqual(pinned);
    expect(request.mock.calls[1]?.[1].headers).toHaveProperty("if-none-match", '"one"');
    request.mockResolvedValueOnce(Response.json(card(`${agent.url}/new-rpc`)));
    await expect(discoverA2AAgent(agent, pinned)).rejects.toThrow("changed during an active task");
  });
  it("sends version, tenant, and per-step credentials only to the selected endpoint", async () => {
    const getToken = vi.fn(async () => ({ token: "fresh" }));
    const ctx = context({ getToken });
    request.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.params.tenant).toBe("travel");
      expect(options.headers.authorization).toBe("Bearer fresh");
      expect(options.headers["a2a-version"]).toBe("1.0");
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          message: {
            messageId: "reply",
            contextId: "context",
            role: "ROLE_AGENT",
            parts: [{ text: "Done" }],
          },
        },
      });
    });
    const result = await callA2A({
      definition: { ...definition(), auth: { getToken: async () => ({ token: "fresh" }) } },
      endpoint: { url: "https://example.com/rpc", tenant: "travel", contract: "hash" },
      ctx,
      method: "SendMessage",
      params: {},
    });
    expect(await a2aResult(result)).toBe("Done");
    expect(getToken).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ connection: { url: "https://example.com/rpc" } }),
    );
  });
  it("hands rejected credentials to the shared eviction and reauthorization flow", async () => {
    const requireAuth = vi.fn(() => {
      throw new Error("reauthorize");
    });
    request.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      callA2A({
        definition: { ...definition(), auth: { getToken: async () => ({ token: "expired" }) } },
        endpoint: { url: "https://example.com/rpc", contract: "hash" },
        ctx: context({ getToken: async () => ({ token: "expired" }), requireAuth }),
        method: "GetTask",
        params: { id: "task" },
      }),
    ).rejects.toThrow("reauthorize");
    expect(requireAuth).toHaveBeenCalledOnce();
  });
  it("validates structured results before exposing them to the parent", async () => {
    const result = {
      task: {
        id: "task",
        status: { state: "TASK_STATE_COMPLETED" as const },
        artifacts: [{ artifactId: "result", parts: [{ data: { city: "Paris" } }] }],
      },
    };
    await expect(
      a2aResult(result, {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      }),
    ).resolves.toEqual({ city: "Paris" });
    await expect(
      a2aResult(result, {
        type: "object",
        properties: { city: { type: "number" } },
        required: ["city"],
      }),
    ).rejects.toThrow("does not match");
  });

  it("rejects malformed responses and requires one structured result", async () => {
    const result = {
      message: { messageId: "reply", role: "ROLE_AGENT" as const, parts: [{ text: "plain text" }] },
    };
    await expect(a2aResult(result, { type: "object" })).rejects.toThrow("exactly one data part");
    request.mockResolvedValue(Response.json({ jsonrpc: "2.0", id: "wrong", result }));
    await expect(
      callA2A({
        definition: definition(),
        endpoint: { url: "https://example.com/rpc", contract: "hash" },
        ctx: context(),
        method: "SendMessage",
        params: {},
      }),
    ).rejects.toThrow("Invalid A2A JSON-RPC response");
  });
});
