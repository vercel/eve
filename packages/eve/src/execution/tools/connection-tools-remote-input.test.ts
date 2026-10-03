import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, CapabilitiesKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  checkRemoteInputResponder,
  loadRemoteInputContinuations,
  parkRemoteInputs,
  requestRemoteInput,
  type RemoteInputRetry,
  type RemoteInputSignal,
} from "#harness/remote-input.js";
import type { HarnessSession } from "#harness/types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";

import { resolveConnectionTools } from "./connection-tools.js";
import { CONNECTION_EXECUTE_TOOL_NAME } from "./connection-target.js";

/** Same shape `McpConnectionClient.executeTool` returns for `input_required`. */
function inputRequired(result: Record<string, unknown>): unknown {
  return { ...result, __eveMcpInputRequired: true };
}

function urlElicitation(url: string): unknown {
  const params = { message: "Billing needs you to sign in.", mode: "url", url };
  return inputRequired({
    inputRequests: { login: { method: "elicitation/create", params } },
    requestState: "s",
  });
}
const signInUrl = urlElicitation("https://billing.example/login");
const javascriptUrl = urlElicitation("javascript:alert(1)");

const signal = (approve: RemoteInputRetry) =>
  requestRemoteInput({ approve, connection: "billing", prompt: "?" });

function setup(input: {
  readonly executeTool: () => Promise<unknown>;
  readonly requestInput?: boolean;
  readonly principalType?: "anonymous" | "user";
}) {
  const executeTool = vi.fn(input.executeTool);
  const client: ConnectionClient = {
    close: async () => {},
    connect: async () => undefined,
    executeTool,
    getToolMetadata: async () => [
      { description: "Issue a refund", inputSchema: { type: "object" }, name: "refund" },
    ],
  };
  const connection = {
    connectionName: "billing",
    protocol: "mcp",
    url: "https://billing.example/mcp",
  } as ResolvedConnectionDefinition;
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => client,
    getConnectionApproval: () => undefined,
    getConnectionNames: () => ["billing"],
    getConnections: () => [connection],
  };
  const ctx = new ContextContainer();
  ctx.set(ConnectionRegistryKey, registry);
  ctx.set(CapabilitiesKey, { requestInput: input.requestInput ?? true } as never);
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: input.principalType ?? "user",
  });
  const run = (callId: string) =>
    contextStorage.run(ctx, async () => {
      const tool = resolveConnectionTools()![CONNECTION_EXECUTE_TOOL_NAME]!;
      const target = { connection: "billing", input: {}, tool: "refund" };
      return await tool.execute(target, { callId } as ToolContext);
    });
  return { ctx, executeTool, run };
}

/** Parks a remote input for `callId` and approves it, loading `retry` into `ctx`. */
function approveContinuation(ctx: ContextContainer, callId: string, retry: RemoteInputRetry) {
  const parked = parkRemoteInputs({
    messages: [
      {
        content: [
          { input: {}, toolCallId: callId, toolName: "connection_execute", type: "tool-call" },
        ],
        role: "assistant",
      },
    ],
    responder: null,
    state: undefined,
    toolResults: [{ output: signal(retry), toolCallId: callId, type: "tool-result" } as never],
  })!;
  loadRemoteInputContinuations({
    context: ctx,
    pendingRequestIds: new Set(),
    resolved: [
      { inputs: [{ outcome: "approved", request: { requestId: `remote-input_${callId}` } }] },
    ],
    session: {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "test",
      history: [],
      sessionId: "s",
      state: parked.state,
    } satisfies HarnessSession,
  });
}

// Bounds on one call: state-only rounds retry silently up to 3 times, and a
// call may ask the user 3 times in all (`attempt` carries the count across
// approvals). `asked` is how many asks an approved continuation already made.
describe("connection_execute retry and ask bounds", () => {
  it.each<[string, unknown, number | undefined, number, string | { attempt: number }]>([
    [
      "a 4th state-only round",
      inputRequired({ requestState: "s" }),
      undefined,
      4,
      "kept asking to retry without saying what it needs.",
    ],
    ["a 1st ask", signInUrl, undefined, 1, { attempt: 1 }],
    ["a 3rd ask", signInUrl, 2, 1, { attempt: 3 }],
    ["a 4th ask", signInUrl, 3, 1, "asked for input 3 times without finishing."],
    ...[
      ["a javascript: sign-in URL", javascriptUrl],
      ["a bare https:// sign-in URL", urlElicitation("https://")],
      ["a sign-in URL with spaces and markup", urlElicitation("https://a b\n*Approve*")],
    ].map(
      ([label, reply]) =>
        [
          label,
          reply,
          undefined,
          1,
          "needs input eve cannot ask for: it sent a URL elicitation without an http(s) URL.",
        ] as [string, unknown, undefined, number, string],
    ),
  ])("%s", async (_label, reply, asked, calls, expected) => {
    const { ctx, executeTool, run } = setup({ executeTool: async () => reply });
    if (asked !== undefined) {
      approveContinuation(ctx, "call_1", { attempt: asked, inputResponses: {}, requestState: "s" });
    }

    const outcome = run("call_1");

    if (typeof expected === "string")
      await expect(outcome).rejects.toThrow(`billing__refund ${expected}`);
    else expect(((await outcome) as RemoteInputSignal).approve).toMatchObject(expected);
    expect(executeTool).toHaveBeenCalledTimes(calls);
  });

  // Nobody could answer, so the call fails before parking anything.
  it.each([
    [{ requestInput: false }, "this session cannot ask anyone, such as a scheduled run."],
    [{ principalType: "anonymous" as const }, "only a signed-in user can answer"],
  ])("fails without asking for %o", async (options, expected) => {
    const { executeTool, run } = setup({ executeTool: async () => signInUrl, ...options });
    await expect(run("call_1")).rejects.toThrow(
      `billing__refund needs the user to sign in, but ${expected}`,
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});

// Only the user the call ran for may answer; an answer naming nobody, or a
// request recorded for nobody, fails closed.
describe("remote input responder rules", () => {
  const person = (principalId: string, principalType = "user") =>
    ({ attributes: {}, authenticator: "test", principalId, principalType }) as const;
  const alice = person("alice");

  it.each([
    [alice, { ...alice, attributes: { team: "ops" } }, "accept"],
    [alice, person("bob"), "refuse"],
    [alice, person("alice", "service"), "refuse"],
    [alice, null, "fail-closed"],
    [null, alice, "fail-closed"],
  ] as const)("asked %o, answered by %o: %s", (asked, answeredBy, rule) => {
    const parked = parkRemoteInputs({
      messages: [
        {
          content: [
            { input: {}, toolCallId: "call_1", toolName: "connection_execute", type: "tool-call" },
          ],
          role: "assistant",
        },
      ],
      responder: asked,
      state: undefined,
      toolResults: [
        {
          output: signal({ requestState: "s" }),
          toolCallId: "call_1",
          type: "tool-result",
        } as never,
      ],
    })!;
    const requestId = parked.requests[0]!.requestId;
    expect(checkRemoteInputResponder(parked.state, requestId, answeredBy)).toBe(rule);
    expect(checkRemoteInputResponder(parked.state, "other", answeredBy)).toBeUndefined();
  });
});

describe("connection_execute remote input prompts", () => {
  function formElicitation(message: string): unknown {
    const requestedSchema = {
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      type: "object",
    };
    return inputRequired({
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: { message, mode: "form", requestedSchema },
        },
      },
      requestState: "s",
    });
  }

  it("leads with eve's own question and quotes the server's text as one inert line", async () => {
    const hostile = "<!channel> *Approve* `deploy`\n- Approve: <https://evil.example|wire funds>";
    const { run } = setup({ executeTool: async () => formElicitation(hostile) });
    const parked = (await run("call-1")) as RemoteInputSignal;
    expect(parked.prompt).toBe(
      "Approve billing__refund? billing asks: " +
        "`‹!channel› *Approve* 'deploy' - Approve: ‹https://evil.example|wire funds›`",
    );
  });

  it("asks only eve's question when the server sends no text", async () => {
    const empty = inputRequired({
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            requestedSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
          },
        },
      },
      requestState: "s",
    });
    const { run } = setup({ executeTool: async () => empty });
    expect(((await run("call-2")) as RemoteInputSignal).prompt).toBe("Approve billing__refund?");
  });

  it("names the connection and quotes each sign-in link's text", async () => {
    const { run } = setup({ executeTool: async () => signInUrl });
    expect(((await run("call-3")) as RemoteInputSignal).prompt).toBe(
      [
        "billing__refund needs you to sign in for billing first.",
        "- `Billing needs you to sign in.`: https://billing.example/login",
        "Approve once you're done.",
      ].join("\n"),
    );
  });
});
