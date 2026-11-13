import { createHmac } from "node:crypto";

import type { RouteHandlerArgs } from "eve/channels";
import { slackChannel } from "eve/channels/slack";
import type {
  SlackChannelConfig,
  SlackChannelState,
  SlackHandle,
  SlackThread,
} from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject, JsonValue } from "../../json";
import { slackEventContext } from "../../testing/slack";
import { testState, installTestState } from "../../testing/state";
import { isObject } from "../../values";
import {
  createInputRequestEvents,
  inputRequestButtons,
} from "./input-requests";
import type { SlackInputRequest } from "./input-requests";

const metadata = { sequence: 1, stepIndex: 0, turnId: "turn" };
const request = (
  overrides: Partial<SlackInputRequest> = {}
): SlackInputRequest => ({
  action: {
    callId: "call",
    input: {},
    kind: "tool-call",
    toolName: "ask_question",
  },
  kind: "question",
  options: [
    { description: "Technical readers", id: "developers", label: "Developers" },
    { id: "everyone", label: "Everyone" },
  ],
  prompt: "Which audience?",
  requestId: "request-1",
  ...overrides,
});
const approval = (id = "request-1") =>
  request({
    action: {
      callId: "call",
      input: { entry: "123" },
      kind: "tool-call",
      toolName: "publish",
    },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "cancel", label: "Cancel" },
    ],
    requestId: id,
  });
const channelContext = () =>
  slackEventContext({
    slack: {
      request: vi.fn<SlackHandle["request"]>(async () => await { ok: true }),
    },
    state: { threadTs: "1.0" },
    thread: {
      post: vi.fn<SlackThread["post"]>(
        async () =>
          await {
            id: "2.0",
            raw: { ok: true },
          }
      ),
    },
  });
const render = async (input: SlackInputRequest) => {
  const channel = channelContext();
  await createInputRequestEvents()["input.requested"](
    { ...metadata, requests: [input] },
    channel
  );
  const posted = vi.mocked(channel.thread.post).mock.calls[0]?.[0];
  if (!isObject(posted) || !("blocks" in posted)) {
    throw new Error("Expected a Block Kit post");
  }
  return {
    // Block Kit JSON is untyped in eve's post input.
    // SAFETY: The captured payload comes from this test’s Block Kit renderer; its blocks are JSON objects.
    blocks: posted.blocks as JsonObject[],
    text: posted.text ?? "",
  };
};
const fetchMock = vi.fn();
beforeEach(() => {
  testState.reset();
  fetchMock.mockImplementation(() => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

const unused = () => {
  throw new Error("Unexpected channel operation");
};

/* Exercise only eve's exported channel and public webhook route. */
const webhook = (config: Partial<SlackChannelConfig> = {}) => {
  const channel = slackChannel({
    credentials: { botToken: "test", signingSecret: "secret" },
    ...config,
  });
  const [route] = channel.routes;
  if (!route || route.transport === "websocket") {
    throw new Error("Expected Slack HTTP route");
  }
  const { handler } = route;
  const respond = vi.fn().mockImplementation(() => Promise.resolve());

  const session = {
    cancel: unused,
    clear: unused,
    compact: unused,
    getEventStream: unused,
    getStreamTailIndex: unused,
    id: "test",
    reset: unused,
    respond: unused,
    send: unused,
  };
  respond.mockImplementation(() => Promise.resolve(session));
  const from = vi.fn(() => ({
    cancel: unused,
    clear: unused,
    compact: unused,
    reset: unused,
    respond,
    send: unused,
  }));
  const send = async (payload: JsonValue, validSignature = true) => {
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", "secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    const tasks: Parameters<RouteHandlerArgs["waitUntil"]>[0][] = [];
    const result = await handler(
      new Request("https://test.local/eve/v1/slack", {
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": validSignature ? `v0=${digest}` : "v0=invalid",
        },
        method: "POST",
      }),
      {
        attachSession: unused,
        describe: unused,
        from,
        invokeTool: unused,
        listSkillFiles: unused,
        params: {},
        readSkill: unused,
        requestIp: null,
        resolveSession: vi.fn(),
        to: unused,
        waitUntil: (task) => {
          tasks.push(task);
        },
      } satisfies RouteHandlerArgs<SlackChannelState>
    );
    await Promise.all(tasks);
    return result;
  };
  return { from, respond, send };
};
const click = (action: JsonValue, blocks: JsonValue[] = []) => ({
  actions: [action],
  channel: { id: "C123" },
  message: { blocks, thread_ts: "1.0", ts: "2.0" },
  team: { id: "T123" },
  trigger_id: "trigger",
  type: "block_actions",
  user: { id: "U123", team_id: "T123" },
});
const controls = (post: { blocks: JsonObject[] }) => {
  const block = post.blocks.find((item) => item.type === "actions");
  // SAFETY: Callers exercise rendered request options, whose actions block contains the button objects being asserted.
  return block?.elements as JsonObject[];
};

describe("shared input presentation", () => {
  it("falls back independently for mixed requests and preserves custom cards", async () => {
    const channel = channelContext();
    let sequence = 0;
    vi.mocked(channel.thread.post).mockImplementation(async () => {
      sequence += 1;
      return await { id: `ts-${sequence}`, raw: { ok: true } };
    });
    const onPosted = vi.fn();
    const customBlocks = [
      {
        text: { text: "Custom", type: "plain_text" },
        type: "section",
      },
    ];
    const events = createInputRequestEvents({
      render: (input) =>
        input.kind === "tool-approval"
          ? { blocks: customBlocks, onPosted, text: "Custom" }
          : undefined,
    });
    await events["input.requested"](
      {
        ...metadata,
        requests: [
          approval(),
          request({ requestId: "question" }),
          request({ kind: "session-limit", requestId: "limit" }),
        ],
      },
      channel
    );
    const posts = vi.mocked(channel.thread.post).mock.calls;
    expect(posts).toHaveLength(3);
    expect(posts[0]?.[0]).toEqual({ blocks: customBlocks, text: "Custom" });
    for (const [post] of posts.slice(1)) {
      expect(JSON.stringify(post)).toContain("Which audience?");
      expect(JSON.stringify(post)).not.toContain("Custom");
    }
    expect(onPosted).toHaveBeenCalledExactlyOnceWith("ts-1");
    expect(channel.state.pendingApprovalCards).toEqual({
      "request-1": { messageBlocks: customBlocks, messageTs: "ts-1" },
    });
    expect(testState.get("slack.input-request-deliveries")).toEqual({
      limit: "ts-3",
      question: "ts-2",
      "request-1": "ts-1",
    });
    // A replay must not repost, but must re-run onPosted with the original receipt.
    await events["input.requested"](
      { ...metadata, requests: [approval()] },
      channel
    );
    expect(channel.thread.post).toHaveBeenCalledTimes(3);
    expect(onPosted).toHaveBeenCalledTimes(2);
    expect(onPosted).toHaveBeenLastCalledWith("ts-1");
  });
  it.each([
    { id: "", raw: { ok: true } },
    { id: "2.0", raw: { ok: false } },
  ])("does not acknowledge unconfirmed delivery %j", async (result) => {
    const channel = channelContext();
    vi.mocked(channel.thread.post).mockResolvedValue(result);
    const onPosted = vi.fn();
    const events = createInputRequestEvents({
      render: () => ({ blocks: [], onPosted, text: "Preview" }),
    });
    const deliver = () =>
      events["input.requested"](
        { ...metadata, requests: [approval()] },
        channel
      );
    await expect(deliver()).rejects.toThrow("delivery");
    expect(onPosted).not.toHaveBeenCalled();
    expect(channel.state.pendingApprovalCards).toBeUndefined();
    expect(testState.get("slack.input-request-deliveries")).toBeUndefined();
    // Without a delivery receipt, a replay retries the post instead of acknowledging it.
    await expect(deliver()).rejects.toThrow("delivery");
    expect(channel.thread.post).toHaveBeenCalledTimes(2);
    expect(onPosted).not.toHaveBeenCalled();
  });
  it("surfaces renderer failures without falling back to a misleading approval", async () => {
    const channel = channelContext();
    const events = createInputRequestEvents({
      render: () => {
        throw new Error("Missing saved plan");
      },
    });
    await expect(
      events["input.requested"](
        { ...metadata, requests: [approval()] },
        channel
      )
    ).rejects.toThrow("Missing saved plan");
    expect(channel.thread.post).not.toHaveBeenCalled();
  });
  it.each([
    ["pending", undefined, "Checking whether you can approve this action…"],
    [
      "stale",
      undefined,
      "This approval response is no longer current. Check the latest request in this thread.",
    ],
    [
      "failed",
      undefined,
      "Your approval could not be verified. Please try again.",
    ],
    [
      "timed-out",
      undefined,
      "Your approval could not be verified. Please try again.",
    ],
    [
      "rejected",
      "Only <editor> members can approve.",
      "Only ‹editor› members can approve.",
    ],
    [
      "stale",
      "Superseded by a newer request.",
      "Superseded by a newer request.",
    ],
  ] as const)(
    "keeps cards pending and provides private %s feedback (reason: %s)",
    async (outcome, reason, text) => {
      const channel = channelContext();
      channel.state.slackUsersByPrincipal = { "slack:T123:U123": "U123" };
      const events = createInputRequestEvents();
      await events["input.requested"](
        { ...metadata, requests: [approval()] },
        channel
      );
      await events["approval.candidate"](
        {
          ...metadata,
          candidateId: "candidate",
          outcome,
          ...(!(reason === undefined) && { reason }),
          requestId: "request-1",
          responderPrincipalId: "slack:T123:U123",
        },
        channel
      );
      expect(channel.thread.postEphemeral).toHaveBeenCalledExactlyOnceWith(
        "U123",
        {
          blocks: [
            {
              text: expect.objectContaining({
                text: reason ?? text,
                type: "plain_text",
              }),
              type: "section",
            },
          ],
          text,
        }
      );
      expect(channel.state.pendingApprovalCards?.["request-1"]).toBeDefined();
    }
  );
  it("sends no candidate feedback to a responder without a known Slack user", async () => {
    const channel = channelContext();
    await createInputRequestEvents()["approval.candidate"](
      {
        ...metadata,
        candidateId: "candidate",
        outcome: "rejected",
        requestId: "request-1",
        responderPrincipalId: "slack:T123:U999",
      },
      channel
    );
    expect(channel.thread.postEphemeral).not.toHaveBeenCalled();
  });
  it("settles one request without dropping a sibling's controls", async () => {
    const channel = channelContext();
    const events = createInputRequestEvents();
    const first = approval("request-1");
    const second = approval("request-10");
    const blocks = [
      {
        elements: [
          ...inputRequestButtons(first),
          ...inputRequestButtons(second),
        ],
        type: "actions",
      },
    ];
    channel.state.pendingApprovalCards = {
      [first.requestId]: { messageBlocks: blocks, messageTs: "2.0" },
      [second.requestId]: { messageBlocks: blocks, messageTs: "2.0" },
    };
    await events["approval.settled"](
      {
        ...metadata,
        outcome: "approved",
        requestId: first.requestId,
        responderPrincipalId: "slack:T123:U123",
      },
      channel
    );
    const remaining = channel.state.pendingApprovalCards[second.requestId];
    expect(JSON.stringify(remaining.messageBlocks)).toContain(
      "eve_input:tool-approval:request-10:button:0"
    );
    expect(JSON.stringify(remaining.messageBlocks)).not.toContain(
      "eve_input:tool-approval:request-1:button:0"
    );
    expect(JSON.stringify(remaining.messageBlocks)).toContain("Approved");
  });
  it("shows bounded, literal tool inputs with explicit truncation", async () => {
    const input = approval();
    input.action.input = { text: `<!channel>${"x".repeat(5000)}` };
    const post = await render(input);
    expect(post.text).toContain("[truncated]");
    // Fallback text neutralizes Slack's broadcast syntax; plain_text never parses it.
    expect(post.text).toContain("‹!channel›");
    expect(post.text).not.toContain("<!channel>");
    expect(post.blocks[1]).toMatchObject({
      text: {
        text: expect.stringContaining("<!channel>"),
        type: "plain_text",
      },
    });
  });
  it.each(["approved", "cancelled"] as const)(
    "preserves nested previews and removes controls only after %s settlement",
    async (outcome) => {
      const channel = channelContext();
      const events = createInputRequestEvents({
        render: (input) => ({
          blocks: [
            {
              child_blocks: [
                {
                  text: { text: "Guide and references", type: "plain_text" },
                  type: "section",
                },
                { elements: inputRequestButtons(input), type: "actions" },
              ],
              type: "container",
            },
          ],
          text: "Preview",
        }),
      });
      await events["input.requested"](
        { ...metadata, requests: [approval()] },
        channel
      );
      channel.state.slackUsersByPrincipal = { "slack:T123:U123": "U123" };
      // The pending card retains its controls until settlement removes them.
      expect(
        JSON.stringify(
          channel.state.pendingApprovalCards?.["request-1"]?.messageBlocks
        )
      ).toContain("eve_input:tool-approval:request-1:button:0");
      const event = {
        ...metadata,
        outcome,
        requestId: "request-1",
        responderPrincipalId: "slack:T123:U123",
      };
      vi.mocked(channel.slack.request).mockResolvedValueOnce({
        error: "ratelimited",
        ok: false,
      });
      await expect(events["approval.settled"](event, channel)).rejects.toThrow(
        "ratelimited"
      );
      expect(channel.state.pendingApprovalCards?.["request-1"]).toBeDefined();
      await events["approval.settled"](event, channel);
      const update = vi.mocked(channel.slack.request).mock.calls.at(-1)?.[1];
      expect(JSON.stringify(update)).toContain("Guide and references");
      expect(JSON.stringify(update)).not.toContain("eve_input:");
      expect(update).toMatchObject({
        text: outcome === "approved" ? "Approved" : "Cancelled",
        ts: "2.0",
      });
      expect(JSON.stringify(update)).not.toContain("Published");
      expect(channel.state.pendingApprovalCards?.["request-1"]).toBeUndefined();
      const calls = vi.mocked(channel.slack.request).mock.calls.length;
      await events["approval.settled"](event, channel);
      expect(channel.slack.request).toHaveBeenCalledTimes(calls);
    }
  );
});

describe("eve Slack wire compatibility", () => {
  it.each(["approve", "cancel"])(
    "routes %s with signed actor auth and defers card updates",
    async (value) => {
      const post = await render(approval());
      const action = controls(post).find((item) => item.value === value);
      const native = webhook();
      const completed1 = await native.send(click(action, post.blocks));
      expect(completed1.status).toBe(200);
      expect(native.from).toHaveBeenCalledWith("C123:1.0");
      expect(native.respond).toHaveBeenCalledWith(
        [{ optionId: value, requestId: "request-1" }],
        expect.objectContaining({
          auth: expect.objectContaining({ principalId: "slack:T123:U123" }),
        })
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it.each([2, 7])(
    "decodes a %i-choice select and removes the freeform alternative",
    async (count) => {
      const post = await render(
        request({
          allowFreeform: true,
          display: "select",
          options: Array.from({ length: count }, (_, index) => ({
            id: `option-${index}`,
            label: `Choice ${index}`,
          })),
        })
      );
      const [select] = controls(post);
      expect(select.type).toBe(count === 2 ? "radio_buttons" : "static_select");
      const native = webhook();
      await native.send(
        click(
          {
            ...select,
            selected_option: {
              text: { text: "Choice 1", type: "plain_text" },
              value: "option-1",
            },
          },
          post.blocks
        )
      );
      expect(native.respond).toHaveBeenCalledWith(
        [{ optionId: "option-1", requestId: "request-1" }],
        expect.anything()
      );
      const update = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      const blocks = JSON.parse(update.get("blocks") ?? "null");
      expect(blocks).toEqual(expect.any(Array));
      expect(JSON.stringify(blocks)).not.toContain("eve_input");
    }
  );
  it.each(["question", "session-limit"] as const)(
    "routes %s buttons",
    async (kind) => {
      const post = await render(request({ kind }));
      const native = webhook();
      await native.send(click(controls(post)[0], post.blocks));
      expect(native.respond).toHaveBeenCalledWith(
        [{ optionId: "developers", requestId: "request-1" }],
        expect.anything()
      );
    }
  );
  it("opens eve's free-text modal and routes its submitted answer", async () => {
    const post = await render(
      request({ allowFreeform: true, options: undefined })
    );
    const native = webhook();
    await native.send(click(controls(post)[0], post.blocks));
    expect(native.respond).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://slack.com/api/views.open"
    );
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    const view = JSON.parse(body.get("view") ?? "null");
    const inputBlock = view.blocks.find(
      (block: { type: string }) => block.type === "input"
    );
    await native.send({
      team: { id: "T123" },
      type: "view_submission",
      user: { id: "U123", team_id: "T123" },
      view: {
        ...view,
        state: {
          values: {
            [inputBlock.block_id]: {
              [inputBlock.element.action_id]: {
                type: "plain_text_input",
                value: "My own answer",
              },
            },
          },
        },
      },
    });
    expect(native.respond).toHaveBeenCalledWith(
      [{ requestId: "request-1", text: "My own answer" }],
      expect.objectContaining({
        auth: expect.objectContaining({ principalId: "slack:T123:U123" }),
      })
    );
  });
  it("honors admission rejection without resuming or editing the approval", async () => {
    const post = await render(approval());
    const onInputResponse = vi.fn().mockResolvedValue(null);
    const native = webhook({ onInputResponse });
    await native.send(click(controls(post)[0], post.blocks));
    expect(onInputResponse).toHaveBeenCalled();
    expect(native.respond).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

beforeEach(installTestState);
