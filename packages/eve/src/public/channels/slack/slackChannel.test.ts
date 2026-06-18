import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { decodeSlackApiBody } from "#public/channels/slack/api-encoding.js";
import {
  HITL_ACTION_PREFIX,
  HITL_FREEFORM_MODAL_ACTION_ID,
  HITL_FREEFORM_MODAL_BLOCK_ID,
  HITL_FREEFORM_MODAL_CALLBACK_ID,
} from "#public/channels/slack/hitl.js";
import {
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_SECTION_TEXT_MAX_LENGTH,
} from "#public/channels/slack/limits.js";
import { defaultSlackAuth } from "#public/channels/slack/index.js";
import {
  constrainAuthorizationRequired,
  slackChannel,
  type SlackAuthorizationEventContext,
  type SlackChannelState,
  type SlackEventContext,
} from "#public/channels/slack/slackChannel.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

function getAdapter(channel: unknown): ChannelAdapter<any> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel.adapter;
}

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel as CompiledChannel<T>;
}

// Decodes a captured Slack outbound request body. All Slack API calls
// are sent form-encoded, so the test infra mirrors that to inspect them.
function parseSlackRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  const contentType = init.headers ? new Headers(init.headers).get("content-type") : null;
  return decodeSlackApiBody(init.body, contentType) as Record<string, unknown>;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Record<string, unknown>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

const stubAlsContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    sessionId: "test-session",
    auth: { current: null, initiator: null },
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

/**
 * Accessor whose `set` writes are captured so tests can assert on
 * `setContinuationToken` flowing through the SessionHandle. Returns
 * undefined for unset keys (matching the real `ContextContainer`
 * behavior), while seeding the current continuation token so
 * SessionHandle can preserve the runtime namespace.
 */
function captureAccessor(initialContinuationToken: string): {
  accessor: any;
  writes: Array<[string, unknown]>;
} {
  const writes: Array<[string, unknown]> = [];
  let continuationToken = initialContinuationToken;
  return {
    writes,
    accessor: {
      get: (key: { name: string }) =>
        key.name === "eve.continuationToken" ? continuationToken : undefined,
      set: (key: { name: string }, value: unknown | ((current: unknown) => unknown)) => {
        const next =
          typeof value === "function" ? (value as (current: unknown) => unknown)(undefined) : value;
        if (key.name === "eve.continuationToken") {
          continuationToken = String(next);
        }
        writes.push([key.name, next]);
        return next;
      },
    },
  };
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { type, data } as HandleMessageStreamEvent;
}

const THREAD_STATE = {
  channelId: "C01",
  threadTs: "1700000000.000001",
  teamId: "T01",
};

const SIGNING_SECRET = "test-signing-secret";

function buildSignedRequest(input: {
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  timestamp?: number;
  signingSecret?: string;
}): Request {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = input.signingSecret ?? SIGNING_SECRET;
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${input.body}`)
    .digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    method: "POST",
    headers: {
      "content-type": input.contentType ?? "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
      ...input.headers,
    },
    body: input.body,
  });
}

function buildSignedInteractionRequest(payload: Record<string, unknown>): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return buildSignedRequest({
    body,
    contentType: "application/x-www-form-urlencoded",
  });
}

let mentionCounter = 0;

function buildMentionBody(overrides?: {
  channel?: string;
  ts?: string;
  text?: string;
  teamId?: string;
}): { body: string; channel: string; ts: string } {
  mentionCounter += 1;
  const channel = overrides?.channel ?? "C01";
  const ts = overrides?.ts ?? `1700000000.${String(mentionCounter).padStart(6, "0")}`;
  const body = JSON.stringify({
    type: "event_callback",
    team_id: overrides?.teamId ?? "T01",
    event_id: `Ev${mentionCounter}`,
    event: {
      type: "app_mention",
      user: "U01",
      text: overrides?.text ?? "hello",
      channel,
      ts,
      event_ts: ts,
    },
  });
  return { body, channel, ts };
}

function buildDirectMessageBody(overrides?: {
  channel?: string;
  ts?: string;
  text?: string;
  teamId?: string;
  botId?: string;
  subtype?: string;
  channelType?: string;
}): { body: string; channel: string; ts: string } {
  mentionCounter += 1;
  const channel = overrides?.channel ?? "D01";
  const ts = overrides?.ts ?? `1700000000.${String(mentionCounter).padStart(6, "0")}`;
  const event: Record<string, unknown> = {
    type: "message",
    channel_type: overrides?.channelType ?? "im",
    user: "U01",
    text: overrides?.text ?? "hello",
    channel,
    ts,
    event_ts: ts,
  };
  if (overrides?.botId !== undefined) event.bot_id = overrides.botId;
  if (overrides?.subtype !== undefined) event.subtype = overrides.subtype;
  const body = JSON.stringify({
    type: "event_callback",
    team_id: overrides?.teamId ?? "T01",
    event_id: `Ev${mentionCounter}`,
    event,
  });
  return { body, channel, ts };
}

async function firePost(
  channel: unknown,
  request: Request,
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const post = compiled.routes.find((r) => r.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected slack channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ id: "s1", continuationToken: "ct" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    send,
    waitUntil,
    getSession: vi.fn() as any,
    params: {},
    requestIp: null,
  } as any);

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

describe("slackChannel() default event handlers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("message.completed posts the agent message via Slack API", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Hello from the agent",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel: "C01",
      thread_ts: "1700000000.000001",
      markdown_text: "Hello from the agent",
    });
  });

  it("message.completed skips post when finishReason is tool-calls", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "tool-calls",
        message: "Should not post",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("input.requested posts an approval card with Slack-unique button action ids", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: {
              callId: "call_abc123",
              input: { operation: "deleteMany" },
              kind: "tool-call",
              toolName: "mongodb-mutate",
            },
            display: "confirmation",
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve tool call: mongodb-mutate",
            requestId: "approval_abc123",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    const body = parseSlackRequestBody(init as RequestInit) as {
      blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }>;
      channel: string;
      text: string;
      thread_ts: string;
    };
    expect(body).toMatchObject({
      channel: "C01",
      text: "Approve tool call: mongodb-mutate",
      thread_ts: "1700000000.000001",
    });

    const actions = body.blocks.find((block) => Array.isArray(block.elements));
    const actionIds = actions?.elements?.map((element) => element.action_id) ?? [];
    expect(actionIds).toEqual([
      `${HITL_ACTION_PREFIX}approval_abc123:button:0`,
      `${HITL_ACTION_PREFIX}approval_abc123:button:1`,
    ]);
    expect(new Set(actionIds).size).toBe(actionIds.length);
  });

  it("input.requested caps section and fallback text so Slack does not reject the post", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const longPrompt = "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500);

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: {
              callId: "call_long",
              input: {},
              kind: "tool-call",
              toolName: "ask_question",
            },
            display: "text",
            prompt: longPrompt,
            requestId: "call_long",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseSlackRequestBody(init as RequestInit) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
      text: string;
    };
    const promptSection = body.blocks.find((block) => block.type === "section");
    expect(promptSection?.text?.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(promptSection?.text?.text.endsWith("...")).toBe(true);
    expect(body.text.length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_MAX_LENGTH);
  });

  it("turn.started calls assistant.threads.setStatus", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("turn.started", { sequence: 0, stepIndex: 0, turnId: "t1" }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/assistant.threads.setStatus");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel_id: "C01",
      thread_ts: "1700000000.000001",
      status: "Working...",
      loading_messages: ["Working..."],
    });
  });

  it("reasoning.appended calls assistant.threads.setStatus with a truncated snippet", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const longReasoning =
      "Need to inspect the implementation and verify the Slack typing status behavior before editing.";

    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: longReasoning,
        reasoningSoFar: `${longReasoning}\nThen continue.`,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/assistant.threads.setStatus");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel_id: "C01",
      thread_ts: "1700000000.000001",
    });
    expect((body.status as string).length).toBeLessThanOrEqual(50);
    expect((body.status as string).endsWith("...")).toBe(true);
    expect(body.loading_messages).toEqual([body.status]);
    expect(ctx.state.lastReasoningTypingStatus).toBe(body.status);
  });

  it("reasoning.appended throttles repeated status refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const reasoningEvent = (reasoningSoFar: string) =>
      makeEvent("reasoning.appended", {
        reasoningDelta: reasoningSoFar,
        reasoningSoFar,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      });

    await callEvent(adapter, reasoningEvent("Need to inspect the repo."), ctx);
    vi.setSystemTime(new Date("2026-06-18T12:00:01Z"));
    await callEvent(adapter, reasoningEvent("Need to inspect the repo. Then test."), ctx);
    vi.setSystemTime(new Date("2026-06-18T12:00:05Z"));
    await callEvent(adapter, reasoningEvent("Need to inspect the repo. Then test again."), ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statuses = fetchMock.mock.calls.map(
      ([, init]) => parseSlackRequestBody(init as RequestInit).status,
    );
    expect(statuses).toEqual([
      "Need to inspect the repo.",
      "Need to inspect the repo. Then test again.",
    ]);
  });

  it("turn.started resets reasoning status throttling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: "Need to inspect the repo.",
        reasoningSoFar: "Need to inspect the repo.",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );
    vi.setSystemTime(new Date("2026-06-18T12:00:01Z"));
    await callEvent(
      adapter,
      makeEvent("turn.started", { sequence: 0, stepIndex: 0, turnId: "t2" }),
      ctx,
    );
    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: "Fresh turn reasoning.",
        reasoningSoFar: "Fresh turn reasoning.",
        sequence: 1,
        stepIndex: 0,
        turnId: "t2",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const statuses = fetchMock.mock.calls.map(
      ([, init]) => parseSlackRequestBody(init as RequestInit).status,
    );
    expect(statuses).toEqual(["Need to inspect the repo.", "Working...", "Fresh turn reasoning."]);
  });

  it("session.failed posts a terminal markdown message with error hint and id", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("session.failed", {
        code: "internal",
        details: { errorId: "abc-123", name: "WorkflowExecutionFailed" },
        message: "boom",
        sessionId: "s1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(body.markdown_text).toContain("couldn't recover");
    expect(body.markdown_text).toContain("Start a new thread");
    expect(body.markdown_text).toContain("WorkflowExecutionFailed");
    expect(body.markdown_text).toContain("abc-123");
  });

  it("actions.requested typing indicator is truncated to Slack's length cap", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    const longTool = "search_internal_documentation_for_relevant_passages";

    await callEvent(
      adapter,
      makeEvent("actions.requested", {
        actions: [
          { kind: "tool-call", toolName: longTool, callId: "c1", input: {} },
          { kind: "tool-call", toolName: longTool, callId: "c2", input: {} },
          { kind: "tool-call", toolName: longTool, callId: "c3", input: {} },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect((body.status as string).length).toBeLessThanOrEqual(50);
    expect((body.status as string).endsWith("...")).toBe(true);
  });
});

describe("rebuildSlackContext", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("seeds ctx.slack with state channelId / threadTs / teamId", () => {
    const adapter = withState(getAdapter(slackChannel()), THREAD_STATE);
    const ctx = buildAdapterContext(adapter, stubAccessor());
    expect(ctx.slack.channelId).toBe("C01");
    expect(ctx.slack.threadTs).toBe("1700000000.000001");
    expect(ctx.slack.teamId).toBe("T01");
    expect(ctx.session).toBeDefined();
    expect("threadId" in ctx.thread).toBe(false);
    expect("id" in ctx.thread).toBe(false);
  });

  it("falls back to empty strings when state has no thread", () => {
    const adapter = withState(getAdapter(slackChannel()), {
      channelId: null,
      threadTs: null,
      teamId: null,
    });
    const ctx = buildAdapterContext(adapter, stubAccessor());
    expect(ctx.slack.channelId).toBe("");
    expect(ctx.slack.threadTs).toBe("");
    expect("threadId" in ctx.thread).toBe(false);
  });

  it("auto-anchors state.threadTs and re-keys the session on the first post", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1800000000.123456" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      {
        channelId: "C01",
        threadTs: null,
        teamId: null,
      },
    );
    const { accessor, writes } = captureAccessor("slack:C01:");
    const ctx = buildAdapterContext(adapter, accessor);

    // Fire message.completed → default handler posts the agent message.
    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Daily digest",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(firstBody.thread_ts).toBeUndefined();
    expect((adapter.state as { threadTs: string | null }).threadTs).toBe("1800000000.123456");

    // The anchor moment wrote the new continuation token to context
    // via `session.setContinuationToken(...)`. The workflow body picks
    // this up via `reconcileSessionContinuationToken` after the step.
    const tokenWrites = writes.filter(([key]) => key === "eve.continuationToken");
    expect(tokenWrites).toEqual([["eve.continuationToken", "slack:C01:1800000000.123456"]]);

    // A follow-up message.completed now threads under the anchor.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1800000000.999999" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Follow-up detail",
        sequence: 1,
        stepIndex: 1,
        turnId: "t2",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = parseSlackRequestBody(fetchMock.mock.calls[1]![1] as RequestInit);
    expect(secondBody.thread_ts).toBe("1800000000.123456");

    // Once anchored, setContinuationToken does not fire again — the
    // raw token is unchanged across subsequent posts.
    const allTokenWrites = writes.filter(([key]) => key === "eve.continuationToken");
    expect(allTokenWrites).toHaveLength(1);
  });
});

describe("defaultSlackAuth", () => {
  it("is exported from the public Slack entry point", () => {
    const auth = defaultSlackAuth(
      {
        attachments: [],
        author: {
          fullName: undefined,
          isBot: false,
          isMe: false,
          userId: "U01",
          userName: "ada",
        },
        channelId: "C01",
        markdown: "hello",
        raw: {},
        teamId: "T01",
        text: "hello",
        threadTs: "1700000000.000001",
        ts: "1700000000.000002",
      },
      {
        slack: { channelId: "C01", threadTs: "1700000000.000001", teamId: "T01" } as never,
        thread: {} as never,
      },
    );

    expect(auth).toMatchObject({
      attributes: {
        channel_id: "C01",
        thread_ts: "1700000000.000001",
        user_id: "U01",
        user_name: "ada",
      },
      authenticator: "slack-webhook",
      principalId: "slack:T01:U01",
      principalType: "user",
    });
  });
});

describe("slackChannel() inbound mention pipeline", () => {
  const ORIGINAL_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    if (ORIGINAL_SIGNING_SECRET === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
    }
    if (ORIGINAL_BOT_TOKEN === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
    }
  });

  it("answers Slack's URL verification challenge", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const { response } = await firePost(channel, buildSignedRequest({ body }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });

  it("dispatches when onAppMention returns an auth result", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => ({
        auth: {
          attributes: { role: "admin" },
          authenticator: "test",
          principalId: "U999",
          principalType: "user",
        },
      }),
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(send).toHaveBeenCalledTimes(1);
    const [, options] = send.mock.calls[0]!;
    expect((options as { auth: unknown }).auth).toEqual({
      attributes: { role: "admin" },
      authenticator: "test",
      principalId: "U999",
      principalType: "user",
    });
  });

  it("drops Slack http_timeout retries without dispatching", async () => {
    const onAppMention = vi.fn().mockReturnValue({ auth: null });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention,
    });

    const { body } = buildMentionBody();
    const { response, send, waitUntil } = await firePost(
      channel,
      buildSignedRequest({
        body,
        headers: {
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": "http_timeout",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(onAppMention).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("processes the original Slack delivery when retry num is 0", async () => {
    const onAppMention = vi.fn().mockReturnValue({ auth: null });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention,
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(
      channel,
      buildSignedRequest({
        body,
        headers: {
          "x-slack-retry-num": "0",
          "x-slack-retry-reason": "http_timeout",
        },
      }),
    );

    expect(onAppMention).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("processes Slack retries for non-timeout reasons", async () => {
    const onAppMention = vi.fn().mockReturnValue({ auth: null });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention,
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(
      channel,
      buildSignedRequest({
        body,
        headers: {
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": "http_error",
        },
      }),
    );

    expect(onAppMention).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops a redelivery of an already-handled event_id", async () => {
    const onAppMention = vi.fn().mockReturnValue({ auth: null });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention,
    });

    const { body } = buildMentionBody();

    const first = await firePost(channel, buildSignedRequest({ body }));
    expect(first.response.status).toBe(200);
    expect(onAppMention).toHaveBeenCalledTimes(1);

    const second = await firePost(channel, buildSignedRequest({ body }));
    expect(second.response.status).toBe(200);
    expect(await second.response.text()).toBe("ok");
    expect(onAppMention).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
  });

  it("prepends the slack_context block before onAppMention context in send()", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => ({ auth: null, context: ["prior thread context"] }),
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0]!;
    const { context } = payload as { context: readonly string[] };
    expect(context).toHaveLength(2);
    expect(context[0]).toContain("<slack_context>");
    expect(context[0]).toContain("user_id: U01");
    expect(context[1]).toBe("prior thread context");
    expect((payload as { message?: unknown }).message).toBeDefined();
  });

  it("delivers the slack_context block even when onAppMention returns no context", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => ({ auth: null }),
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0]!;
    const { context } = payload as { context: readonly string[] };
    expect(context).toHaveLength(1);
    expect(context[0]).toContain("<slack_context>");
  });

  it("does not dispatch when onAppMention resolves to null", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => null,
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(send).not.toHaveBeenCalled();
  });

  it("awaits an async onAppMention before deciding whether to dispatch", async () => {
    const runOrder: string[] = [];
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      async onAppMention() {
        runOrder.push("onAppMention:start");
        await new Promise((resolve) => setTimeout(resolve, 0));
        runOrder.push("onAppMention:end");
        return { auth: null };
      },
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(runOrder).toEqual(["onAppMention:start", "onAppMention:end"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("default onAppMention posts a 'Thinking...' typing indicator", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const { body } = buildMentionBody();
    await firePost(channel, buildSignedRequest({ body }));

    const typingCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("assistant.threads.setStatus"),
    );
    expect(typingCall).toBeDefined();
    const sent = parseSlackRequestBody(typingCall![1] as RequestInit);
    expect(sent.status).toBe("Thinking...");
  });

  it("returns 200 OK without dispatching for non-app_mention events", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "reaction_added", item: { type: "message" } },
    });
    const { response, send } = await firePost(channel, buildSignedRequest({ body }));
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects requests with a bad signature", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const { body } = buildMentionBody();
    const req = buildSignedRequest({ body, signingSecret: "wrong-secret" });
    const { response, send } = await firePost(channel, req);
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs and drops the mention when onAppMention throws", async () => {
    const onAppMention = vi.fn().mockRejectedValue(new Error("typing failed"));
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention,
    });

    const { body } = buildMentionBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onAppMention).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slackChannel() inbound direct message pipeline", () => {
  const ORIGINAL_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    if (ORIGINAL_SIGNING_SECRET === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
    }
    if (ORIGINAL_BOT_TOKEN === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
    }
  });

  it("dispatches when onDirectMessage returns an auth result", async () => {
    const onDirectMessage = vi.fn().mockReturnValue({
      auth: {
        attributes: { surface: "im" },
        authenticator: "test",
        principalId: "U01",
        principalType: "user",
      },
    });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage,
    });

    const { body, channel: channelId } = buildDirectMessageBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onDirectMessage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [, options] = send.mock.calls[0]!;
    const opts = options as { auth: unknown; state: { channelId: string } };
    expect(opts.auth).toMatchObject({ principalId: "U01", authenticator: "test" });
    expect(opts.state.channelId).toBe(channelId);
  });

  it("does not dispatch when onDirectMessage resolves to null", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage: () => null,
    });

    const { body } = buildDirectMessageBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores message events that are not IM (channel posts)", async () => {
    const onDirectMessage = vi.fn();
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage,
    });

    const { body } = buildDirectMessageBody({ channelType: "channel" });
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onDirectMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("filters bot-authored DMs so the bot's own replies do not re-trigger", async () => {
    const onDirectMessage = vi.fn();
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage,
    });

    const { body } = buildDirectMessageBody({ botId: "B01" });
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onDirectMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("filters subtype messages (edits, deletes, joins)", async () => {
    const onDirectMessage = vi.fn();
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage,
    });

    const { body } = buildDirectMessageBody({ subtype: "message_changed" });
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onDirectMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("default onDirectMessage posts a 'Thinking...' typing indicator and dispatches", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const { body } = buildDirectMessageBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    const typingCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("assistant.threads.setStatus"),
    );
    expect(typingCall).toBeDefined();
    const sent = parseSlackRequestBody(typingCall![1] as RequestInit);
    expect(sent.status).toBe("Thinking...");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("logs and drops the DM when onDirectMessage throws", async () => {
    const onDirectMessage = vi.fn().mockRejectedValue(new Error("bad handler"));
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onDirectMessage,
    });

    const { body } = buildDirectMessageBody();
    const { send } = await firePost(channel, buildSignedRequest({ body }));

    expect(onDirectMessage).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slackChannel() HITL interaction pipeline", () => {
  const ORIGINAL_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    if (ORIGINAL_SIGNING_SECRET === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
    }
    if (ORIGINAL_BOT_TOKEN === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
    }
  });

  it("resumes HITL button answers with the approving Slack user auth", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "block_actions",
        team: { id: "T01" },
        user: {
          id: "U_APPROVER",
          username: "ada",
          name: "ada",
          team_id: "T01",
        },
        channel: { id: "C01" },
        message: {
          ts: "1700000000.000010",
          thread_ts: "1700000000.000001",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Approve?" } }],
        },
        actions: [
          {
            action_id: `${HITL_ACTION_PREFIX}approval_abc123:button:0`,
            text: { type: "plain_text", text: "Approve" },
            value: "approve",
          },
        ],
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "approval_abc123" }],
    });
    expect(options).toMatchObject({
      auth: {
        attributes: {
          author_type: "user",
          channel_id: "C01",
          team_id: "T01",
          thread_ts: "1700000000.000001",
          user_id: "U_APPROVER",
          user_name: "ada",
        },
        authenticator: "slack-webhook",
        issuer: "slack:T01",
        principalId: "slack:T01:U_APPROVER",
        principalType: "user",
      },
      continuationToken: "C01:1700000000.000001",
      state: {
        channelId: "C01",
        teamId: "T01",
        threadTs: "1700000000.000001",
        triggeringUserId: "U_APPROVER",
      },
    });
  });

  it("resumes freeform modal answers with the submitting Slack user auth", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "view_submission",
        team: { id: "T01" },
        user: {
          id: "U_SUBMITTER",
          username: "grace",
          name: "grace",
          team_id: "T01",
        },
        view: {
          callback_id: HITL_FREEFORM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({
            channelId: "C01",
            continuationToken: "C01:1700000000.000001",
            messageTs: "1700000000.000010",
            requestId: "call_abc123",
            threadTs: "1700000000.000001",
          }),
          state: {
            values: {
              [HITL_FREEFORM_MODAL_BLOCK_ID]: {
                [HITL_FREEFORM_MODAL_ACTION_ID]: { value: "approved with context" },
              },
            },
          },
        },
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toEqual({
      inputResponses: [{ requestId: "call_abc123", text: "approved with context" }],
    });
    expect(options).toMatchObject({
      auth: {
        attributes: {
          author_type: "user",
          channel_id: "C01",
          team_id: "T01",
          thread_ts: "1700000000.000001",
          user_id: "U_SUBMITTER",
          user_name: "grace",
        },
        authenticator: "slack-webhook",
        issuer: "slack:T01",
        principalId: "slack:T01:U_SUBMITTER",
        principalType: "user",
      },
      continuationToken: "C01:1700000000.000001",
      state: {
        channelId: "C01",
        teamId: "T01",
        threadTs: "1700000000.000001",
        triggeringUserId: "U_SUBMITTER",
      },
    });
  });
});

describe("slackChannel() webhookVerifier credentials path", () => {
  const ORIGINAL_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  beforeEach(() => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "1.0" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterAll(() => {
    if (ORIGINAL_SIGNING_SECRET === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
    }
    if (ORIGINAL_BOT_TOKEN === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
    }
  });

  it("uses webhookVerifier instead of HMAC when supplied", async () => {
    const verifier = vi.fn().mockResolvedValue(true);
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", webhookVerifier: verifier },
    });

    const { body } = buildMentionBody();
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const { response, send } = await firePost(channel, req);
    expect(response.status).toBe(200);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects with 401 when webhookVerifier throws", async () => {
    const verifier = vi.fn().mockRejectedValue(new Error("nope"));
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", webhookVerifier: verifier },
    });

    const { body } = buildMentionBody();
    const req = new Request("https://example.com/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const { response, send } = await firePost(channel, req);
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slackChannel().receive", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function buildReceive() {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const compiled = asCompiled(channel);
    if (!compiled.receive) throw new Error("expected compiled.receive");
    return compiled.receive;
  }

  it("sends with an explicit continuation token built from channelId + threadTs", async () => {
    const send = vi.fn().mockResolvedValue({ id: "s", continuationToken: "ct" });
    await buildReceive()(
      {
        message: "do the thing",
        target: { channelId: "C123", threadTs: "1700000000.000001" },
        auth: { attributes: {}, authenticator: "app", principalId: "p", principalType: "user" },
      },
      { send },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [message, options] = send.mock.calls[0]!;
    expect(message).toBe("do the thing");
    expect(options.continuationToken).toBe("C123:1700000000.000001");
    expect(options.state).toEqual({
      channelId: "C123",
      threadTs: "1700000000.000001",
      teamId: null,
      triggeringUserId: null,
    });
    expect(options.auth.principalId).toBe("p");
  });

  it("requires channelId", async () => {
    const send = vi.fn();
    await expect(
      buildReceive()({ message: "x", target: {}, auth: null }, { send }),
    ).rejects.toThrow(/requires target.channelId/);
    expect(send).not.toHaveBeenCalled();
  });

  it("posts the initial card before send and threads under its ts", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1800000000.000900" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const send = vi.fn().mockResolvedValue({ id: "s", continuationToken: "ct" });

    const { Card, CardText } = await import("#compiled/chat/index.js");
    await buildReceive()(
      {
        message: "start the investigation",
        target: {
          channelId: "C123",
          initialMessage: {
            card: Card({ children: [CardText("Investigation Thread for INC-1")] }),
            fallbackText: "Investigation INC-1",
          },
        },
        auth: null,
      },
      { send },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("chat.postMessage");
    const body = parseSlackRequestBody(init as RequestInit) as {
      channel: string;
      blocks: unknown[];
    };
    expect(body.channel).toBe("C123");
    expect(Array.isArray(body.blocks)).toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const [, options] = send.mock.calls[0]!;
    expect(options.continuationToken).toBe("C123:1800000000.000900");
    expect(options.state.threadTs).toBe("1800000000.000900");
  });

  it("rejects passing both threadTs and initialMessage", async () => {
    const send = vi.fn();
    const { Card, CardText } = await import("#compiled/chat/index.js");
    await expect(
      buildReceive()(
        {
          message: "x",
          target: {
            channelId: "C1",
            threadTs: "1700000000.000001",
            initialMessage: { card: Card({ children: [CardText("x")] }) },
          },
          auth: null,
        },
        { send },
      ),
    ).rejects.toThrow(/mutually exclusive/);
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces a Slack post failure as a thrown error and does not call send", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const send = vi.fn();
    const { Card, CardText } = await import("#compiled/chat/index.js");
    await expect(
      buildReceive()(
        {
          message: "x",
          target: {
            channelId: "C1",
            initialMessage: {
              card: Card({ children: [CardText("anchor")] }),
              fallbackText: "anchor",
            },
          },
          auth: null,
        },
        { send },
      ),
    ).rejects.toThrow(/not_in_channel/);
    expect(send).not.toHaveBeenCalled();
  });

  // Pins the resumability guarantee: the continuation token minted by
  // `receive({ initialMessage })` is byte-equal to the token an inbound
  // @-mention reply in that same thread computes. Without this, a
  // schedule's anchor card would orphan the parked session and the
  // first human follow-up would silently start a fresh one.
  it("uses the same continuation token on receive and on a follow-up inbound mention", async () => {
    const initialMessageTs = "1800000000.001234";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: initialMessageTs }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const send = vi.fn().mockResolvedValue({ id: "s", continuationToken: "ct" });
    const { Card, CardText } = await import("#compiled/chat/index.js");

    await buildReceive()(
      {
        message: "Start the digest.",
        target: {
          channelId: "C123",
          initialMessage: {
            card: Card({ children: [CardText("Daily Deploy Digest")] }),
            fallbackText: "Daily Deploy Digest",
          },
        },
        auth: null,
      },
      { send },
    );
    const receiveToken = (send.mock.calls[0]![1] as { continuationToken: string })
      .continuationToken;
    expect(receiveToken).toBe(`C123:${initialMessageTs}`);

    // Now simulate Slack delivering an `app_mention` reply threaded
    // under the anchor card. The inbound dispatch path builds the
    // token from `event.thread_ts` so it matches the one receive()
    // used, and the parked session resumes via runtime.deliver.
    const inboundSend = vi.fn().mockResolvedValue({ id: "s", continuationToken: "ct" });
    const mentionBody = JSON.stringify({
      type: "event_callback",
      team_id: "T01",
      event_id: "Ev_threaded_reply",
      event: {
        type: "app_mention",
        user: "U999",
        text: "<@U_BOT> any progress?",
        channel: "C123",
        ts: "1800000000.005000",
        thread_ts: initialMessageTs,
        event_ts: "1800000000.005000",
      },
    });
    const req = buildSignedRequest({ body: mentionBody });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
    });
    const compiled = asCompiled(channel);
    const post = compiled.routes.find((r) => r.method === "POST");
    if (!post) throw new Error("expected POST route");
    const waitUntil = vi.fn();
    await post.handler(req, {
      send: inboundSend,
      waitUntil,
      getSession: vi.fn() as any,
      receive: vi.fn() as any,
      params: {},
      requestIp: null,
    } as any);

    let drained = 0;
    while (drained < waitUntil.mock.calls.length) {
      const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
      drained = waitUntil.mock.calls.length;
      await Promise.allSettled(pending);
    }

    expect(inboundSend).toHaveBeenCalledTimes(1);
    const inboundToken = (inboundSend.mock.calls[0]![1] as { continuationToken: string })
      .continuationToken;
    expect(inboundToken).toBe(receiveToken);
  });
});

describe("constrainAuthorizationRequired", () => {
  function buildFullContext() {
    const postEphemeral = vi.fn().mockResolvedValue({ id: "eph1" });
    const postDirectMessage = vi.fn().mockResolvedValue({ id: "dm1" });
    const post = vi.fn().mockResolvedValue({ id: "ts1" });
    const request = vi.fn().mockResolvedValue({ ok: true });
    const state: SlackChannelState = {
      channelId: "C123",
      threadTs: "111.222",
      teamId: null,
      triggeringUserId: "U777",
    };
    const channel = {
      thread: { postEphemeral, postDirectMessage, post } as Partial<SlackEventContext["thread"]>,
      slack: { channelId: "C123", request } as Partial<SlackEventContext["slack"]>,
      state,
    } as SlackEventContext;
    return { channel, post, postDirectMessage, postEphemeral, request, state };
  }

  const eventData = {
    authorization: { url: "https://connect.example.com/a/sca_1", userCode: "AAA-BBB" },
    description: "Authorization required for notion",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  };

  it("hands the override only the private-delivery surface", async () => {
    const { channel } = buildFullContext();
    let received: SlackAuthorizationEventContext | undefined;
    const constrained = constrainAuthorizationRequired((_data, authCtx) => {
      received = authCtx;
    });

    await constrained(eventData, channel, {} as SessionContext);

    expect(received).toBeDefined();
    expect(Object.keys(received!).sort()).toEqual(["postDirectMessage", "postEphemeral", "state"]);
    expect("thread" in received!).toBe(false);
    expect("slack" in received!).toBe(false);
    expect(received!.state.triggeringUserId).toBe("U777");
  });

  it("delegates private delivery to the underlying thread", async () => {
    const { channel, postDirectMessage, postEphemeral } = buildFullContext();
    const constrained = constrainAuthorizationRequired(async (_data, authCtx) => {
      await authCtx.postEphemeral("U777", "psst");
      await authCtx.postDirectMessage("U777", "psst dm");
    });

    await constrained(eventData, channel, {} as SessionContext);

    expect(postEphemeral).toHaveBeenCalledWith("U777", "psst");
    expect(postDirectMessage).toHaveBeenCalledWith("U777", "psst dm");
  });

  it("threads the event data and session context through unchanged", async () => {
    const { channel } = buildFullContext();
    const sessionCtx = {} as SessionContext;
    const handler = vi.fn();

    await constrainAuthorizationRequired(handler)(eventData, channel, sessionCtx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(eventData);
    expect(handler.mock.calls[0]?.[2]).toBe(sessionCtx);
  });
});
