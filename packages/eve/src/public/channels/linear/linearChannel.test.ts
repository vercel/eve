import { describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { renderLinearInputRequests } from "#public/channels/linear/hitl.js";
import { linearChannel, type LinearChannelState } from "#public/channels/linear/linearChannel.js";
import { signLinearWebhookBody } from "#public/channels/linear/verify.js";
import type { InputRequest } from "#runtime/input/types.js";

const SECRET = "linear-secret";

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
  return channel as CompiledChannel<T>;
}

function getAdapter(channel: unknown): ChannelAdapter<any> {
  return asCompiled(channel).adapter;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Partial<LinearChannelState>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

const stubAlsContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "test-session",
    turn: { id: "test-turn", sequence: 0 },
  });
  return ctx;
})();

function callEvent(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: any,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { data, type } as HandleMessageStreamEvent;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function signedRequest(payload: Record<string, unknown>): Request {
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    webhookTimestamp: Date.now(),
    ...payload,
  });
  return new Request("https://example.com/eve/v1/linear", {
    body,
    headers: {
      "content-type": "application/json",
      "linear-delivery": "delivery_1",
      "linear-event": "AgentSessionEvent",
      "linear-signature": signLinearWebhookBody(body, SECRET),
    },
    method: "POST",
  });
}

function sessionPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    agentSession: {
      creator: { displayName: "Ada Lovelace", id: "user_1" },
      id: "agent_session_1",
      issue: {
        id: "issue_1",
        identifier: "EVE-123",
        title: "Implement Linear channel",
        url: "https://linear.app/acme/issue/EVE-123",
      },
      issueId: "issue_1",
      organizationId: "org_1",
      url: "https://linear.app/acme/agent-session/agent_session_1",
    },
    organizationId: "org_1",
    promptContext: "Please handle this issue.",
    ...extra,
  };
}

async function firePost(
  channel: unknown,
  request: Request,
): Promise<{
  readonly response: Response;
  readonly send: ReturnType<typeof vi.fn>;
  readonly waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled<LinearChannelState>(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected linear channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "linear:test", id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    getSession: vi.fn() as any,
    params: {},
    receive: vi.fn() as any,
    requestIp: null,
    send,
    waitUntil,
  });

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

function makeRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
    prompt: "Approve deployment?",
    requestId: "call_1",
    ...overrides,
  };
}

describe("linearChannel inbound Agent Session events", () => {
  it("dispatches created events with auth, context, token, and state", async () => {
    const channel = linearChannel({ credentials: { webhookSecret: SECRET } });
    const { response, send } = await firePost(channel, signedRequest(sessionPayload()));

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toBe("Please handle this issue.");
    expect(payload.context[0]).toContain("<linear_context>");
    expect(payload.context[0]).toContain("issue_identifier: EVE-123");
    expect(options).toMatchObject({
      auth: {
        authenticator: "linear-agent-webhook",
        principalId: "linear:user_1",
      },
      continuationToken: "agent-session:agent_session_1",
      state: {
        agentSessionId: "agent_session_1",
        issueId: "issue_1",
        issueIdentifier: "EVE-123",
        organizationId: "org_1",
      },
    });
  });

  it("resolves prompted events into input responses when the latest elicitation has eve metadata", async () => {
    const elicitation = renderLinearInputRequests([
      makeRequest({
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          agentSession: {
            activities: {
              nodes: [
                {
                  content: {
                    __typename: "AgentActivityElicitationContent",
                    body: elicitation,
                    type: "elicitation",
                  },
                  id: "activity_1",
                  updatedAt: "2026-06-08T12:00:00.000Z",
                },
              ],
            },
          },
        },
      }),
    );
    const channel = linearChannel({
      api: { apiBaseUrl: "https://linear.test/graphql", fetch: fetchMock },
      credentials: { accessToken: "linear-token", webhookSecret: SECRET },
    });

    const { send } = await firePost(
      channel,
      signedRequest(
        sessionPayload({
          action: "prompted",
          agentActivity: {
            content: { body: "approve", type: "prompt" },
            id: "activity_prompt",
            user: { id: "user_1" },
            userId: "user_1",
          },
        }),
      ),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0]!;
    expect(payload.inputResponses).toEqual([{ optionId: "approve", requestId: "call_1" }]);
    expect(payload.message).toBe("approve");
  });

  it("acks generic data webhooks without dispatch when no hook is configured", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: Date.now(),
    });
    const request = new Request("https://example.com/eve/v1/linear", {
      body,
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearWebhookBody(body, SECRET),
      },
      method: "POST",
    });

    const { response, send } = await firePost(
      linearChannel({ credentials: { webhookSecret: SECRET } }),
      request,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true, ok: true });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("linearChannel default event handlers", () => {
  it("posts completed messages as Linear response activities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          agentActivityCreate: {
            agentActivity: { id: "activity_1" },
            success: true,
          },
        },
      }),
    );
    const adapter = withState(
      getAdapter(
        linearChannel({
          api: { apiBaseUrl: "https://linear.test/graphql", fetch: fetchMock },
          credentials: { accessToken: "linear-token", webhookSecret: SECRET },
        }),
      ),
      { agentSessionId: "agent_session_1" },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Final answer",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://linear.test/graphql");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer linear-token");
    expect(requestBody(init)).toMatchObject({
      variables: {
        input: {
          agentSessionId: "agent_session_1",
          content: { body: "Final answer", type: "response" },
        },
      },
    });
    expect((requestBody(init).variables as any).input).not.toHaveProperty("ephemeral");
  });

  it("posts turn-start and tool-call progress as ephemeral Linear activities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          agentActivityCreate: {
            agentActivity: { id: "activity_1" },
            success: true,
          },
        },
      }),
    );
    const adapter = withState(
      getAdapter(
        linearChannel({
          api: { apiBaseUrl: "https://linear.test/graphql", fetch: fetchMock },
          credentials: { accessToken: "linear-token", webhookSecret: SECRET },
        }),
      ),
      { agentSessionId: "agent_session_1" },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("turn.started", {
        sequence: 0,
        turnId: "t1",
      }),
      ctx,
    );
    await callEvent(
      adapter,
      makeEvent("actions.requested", {
        actions: [{ callId: "call_1", input: {}, kind: "tool-call", toolName: "search" }],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      variables: {
        input: {
          agentSessionId: "agent_session_1",
          content: { body: "Working on this.", type: "thought" },
          ephemeral: true,
        },
      },
    });
    expect(requestBody(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      variables: {
        input: {
          agentSessionId: "agent_session_1",
          content: { action: "search", parameter: "{}", type: "action" },
          ephemeral: true,
        },
      },
    });
  });

  it("surfaces pre-tool-call assistant text as the next ephemeral Linear thought", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          agentActivityCreate: {
            agentActivity: { id: "activity_1" },
            success: true,
          },
        },
      }),
    );
    const adapter = withState(
      getAdapter(
        linearChannel({
          api: { apiBaseUrl: "https://linear.test/graphql", fetch: fetchMock },
          credentials: { accessToken: "linear-token", webhookSecret: SECRET },
        }),
      ),
      { agentSessionId: "agent_session_1" },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "tool-calls",
        message: "\nChecking the issue context first.\nThen I will run a search.",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );
    await callEvent(
      adapter,
      makeEvent("actions.requested", {
        actions: [{ callId: "call_1", input: {}, kind: "tool-call", toolName: "search" }],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      variables: {
        input: {
          agentSessionId: "agent_session_1",
          content: { body: "Checking the issue context first.", type: "thought" },
          ephemeral: true,
        },
      },
    });
    expect(adapter.state?.pendingToolCallMessage).toBeNull();
  });

  it("receive starts a session from an existing Agent Session id", async () => {
    const channel = linearChannel();
    const send = vi.fn().mockResolvedValue({ continuationToken: "linear:test", id: "s1" });

    await channel.receive!(
      {
        auth: null,
        message: "start",
        target: { agentSessionId: "agent_session_1" },
      },
      { send },
    );

    expect(send).toHaveBeenCalledWith("start", {
      auth: null,
      continuationToken: "agent-session:agent_session_1",
      state: {
        agentSessionId: "agent_session_1",
        agentSessionUrl: null,
        commentId: null,
        issueId: null,
        issueIdentifier: null,
        issueTitle: null,
        issueUrl: null,
        organizationId: null,
        pendingToolCallMessage: null,
        sourceCommentId: null,
      },
    });
  });

  it("receive can create a Linear Agent Session on an issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          agentSessionCreateOnIssue: {
            agentSession: {
              id: "agent_session_2",
              issue: { id: "issue_1", identifier: "EVE-123", title: "Linear work" },
              url: "https://linear.app/acme/agent-session/agent_session_2",
            },
            success: true,
          },
        },
      }),
    );
    const channel = linearChannel({
      api: { apiBaseUrl: "https://linear.test/graphql", fetch: fetchMock },
      credentials: { accessToken: "linear-token" },
    });
    const send = vi.fn().mockResolvedValue({ continuationToken: "linear:test", id: "s1" });

    await channel.receive!(
      {
        auth: null,
        message: "start",
        target: { issueId: "issue_1" },
      },
      { send },
    );

    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      variables: { input: { issueId: "issue_1" } },
    });
    expect(send).toHaveBeenCalledWith("start", {
      auth: null,
      continuationToken: "agent-session:agent_session_2",
      state: expect.objectContaining({
        agentSessionId: "agent_session_2",
        issueId: "issue_1",
        issueIdentifier: "EVE-123",
        organizationId: null,
      }),
    });
  });
});
