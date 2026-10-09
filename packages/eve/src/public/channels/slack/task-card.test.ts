import type { SessionEvent } from "#protocol/session-event.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ScheduleIdKey, SessionKey } from "#context/keys.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import {
  createActionsRequestedEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
} from "#protocol/message.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { defineSlackRenderer, type SlackRenderer } from "#public/channels/slack/renderers.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

const TURN_ID = "turn_1";
const DEPLOY_CALL = "call_deploy";
const RESEARCH_CALL = "call_research";
const THREAD = {
  audience: "private",
  channelId: "C01",
  threadTs: "1700000000.000001",
};

/** Records each Slack call; `reply` answers one call, defaulting to success. */
function slackApi(
  reply: (operation: string, index: number) => Record<string, unknown> | undefined = () =>
    undefined,
) {
  const calls: Array<{ readonly body: Record<string, unknown>; readonly operation: string }> = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const operation = String(input).split("/").at(-1)!;
    const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
    calls.push({
      body: decodeSlackApiBody(init?.body ?? "", contentType) as Record<string, unknown>,
      operation,
    });
    const ts = `1700000009.00010${String(calls.length)}`;
    return Response.json(reply(operation, calls.length - 1) ?? { ok: true, ts });
  });
  return { calls, fetch };
}

/**
 * A root session's Slack channel in a thread. `emit` delivers an event the way
 * the session does, keeping the channel's state between events.
 */
function slackThread(
  input: {
    readonly renderers?: readonly SlackRenderer[];
    readonly reply?: Parameters<typeof slackApi>[0];
    readonly schedule?: boolean;
    readonly state?: Record<string, unknown>;
  } = {},
) {
  const { calls, fetch } = slackApi(input.reply);
  const channel = slackChannel({
    api: { fetch },
    credentials: { botToken: "xoxb-test" },
    renderers: input.renderers,
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const adapter: ChannelAdapter = {
    ...channel.adapter,
    state: { ...channel.adapter.state, ...(input.state ?? THREAD) },
  };
  const adapterCtx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as never);
  const session = new ContextContainer();
  session.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session_root",
    turn: { id: TURN_ID, sequence: 0 },
  });
  if (input.schedule === true) session.set(ScheduleIdKey, "nightly-report");
  const emit = async (...events: SessionEvent[]) => {
    for (const event of events) {
      await contextStorage.run(session, () => callAdapterEventHandler(adapter, event, adapterCtx));
    }
  };
  // Card writes carry a task card or plan block; other posts, such as an approval, don't.
  const cardCalls = () =>
    calls.filter((call) => /"type":"(task_card|plan)"/.test(JSON.stringify(call.body["blocks"])));
  return { calls, cardCalls, emit };
}

/** A root turn that starts a deploy tool task and a researcher agent task. */
const TWO_TASKS_STARTED: readonly SessionEvent[] = [
  createActionsRequestedEvent({
    actions: [
      {
        callId: DEPLOY_CALL,
        input: { service: "storefront" },
        kind: "tool-call",
        toolName: "deploy",
      },
      {
        callId: RESEARCH_CALL,
        input: { message: "Find the incidents behind the checkout spike\nInclude timelines." },
        kind: "tool-call",
        toolName: "researcher",
      },
    ],
    presentation: {
      [DEPLOY_CALL]: { label: "Deploy storefront" },
      [RESEARCH_CALL]: { label: "researcher: Find the incidents behind the checkout spike" },
    },
    sequence: 1,
    stepIndex: 0,
    turnId: TURN_ID,
  }),
  createTaskStartedEvent({
    callId: DEPLOY_CALL,
    kind: "tool",
    name: "deploy",
    taskId: "deploy-4hd8sa",
    turnId: TURN_ID,
  }),
  createTaskStartedEvent({
    callId: RESEARCH_CALL,
    kind: "agent",
    name: "researcher",
    taskId: "researcher-7k2m9q",
    turnId: TURN_ID,
  }),
];

const BOTH_TASKS_SETTLED: readonly SessionEvent[] = [
  createTaskSettledEvent({
    callId: DEPLOY_CALL,
    kind: "tool",
    name: "deploy",
    output:
      "The 14:02 deploy changed the cache TTL for every storefront route, so checkout requests missed the cache and queued at the origin. Full log attached.",
    status: "completed",
    taskId: "deploy-4hd8sa",
    turnId: TURN_ID,
  }),
  createTaskSettledEvent({
    callId: RESEARCH_CALL,
    error: { message: "Rate limited by the incidents API\nRetry after 60s." },
    kind: "agent",
    name: "researcher",
    status: "failed",
    taskId: "researcher-7k2m9q",
    turnId: TURN_ID,
  }),
];

const TURN_COMPLETED = createTurnCompletedEvent({ sequence: 2, turnId: TURN_ID });

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack task card", () => {
  it("posts one live card for a turn's tasks, then updates it in place until the turn ends", async () => {
    const { cardCalls, emit } = slackThread();

    await emit(...TWO_TASKS_STARTED);

    expect(cardCalls().map((call) => call.operation)).toEqual(["chat.postMessage", "chat.update"]);
    expect(cardCalls()[0]!.body).toMatchObject({
      channel: "C01",
      thread_ts: "1700000000.000001",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(cardCalls()[1]!.body).toMatchObject({
      blocks: [
        {
          tasks: [
            { status: "in_progress", title: "Deploy storefront" },
            {
              status: "in_progress",
              title: "researcher: Find the incidents behind the checkout spike",
            },
          ],
          title: "Working on 2 tasks",
          type: "plan",
        },
      ],
      text: "Working on 2 tasks: Deploy storefront, researcher: Find the incidents behind the checkout spike",
    });
    const cardTs = cardCalls()[1]!.body["ts"];
    expect(cardTs).toEqual(expect.any(String));

    await emit(...BOTH_TASKS_SETTLED, TURN_COMPLETED);

    expect(cardCalls().at(-1)!.body).toMatchObject({
      blocks: [
        {
          tasks: [
            {
              output: {
                elements: [
                  {
                    elements: [
                      {
                        text: "The 14:02 deploy changed the cache TTL for every storefront route, so checkout requests missed the…",
                      },
                    ],
                  },
                ],
              },
              status: "complete",
            },
            {
              output: {
                elements: [{ elements: [{ text: "Failed: Rate limited by the incidents API" }] }],
              },
              status: "error",
            },
          ],
          title: "Finished 2 tasks: 1 failed",
        },
      ],
      ts: cardTs,
    });

    const written = cardCalls().length;
    await emit(TURN_COMPLETED);
    expect(cardCalls()).toHaveLength(written);
  });

  it("names the agents a turn asks, times their work, and keeps one block id across updates", async () => {
    const start = Date.parse("2026-10-01T10:00:00.000Z");
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
    const agents = [
      { callId: RESEARCH_CALL, name: "researcher", taskId: "researcher-7k2m9q" },
      { callId: "call_review", name: "reviewer", taskId: "reviewer-p3x8vd" },
    ];
    const { cardCalls, emit } = slackThread();
    const plan = () => (cardCalls().at(-1)!.body["blocks"] as BlockKitBlock[])[0]!;

    await emit(
      createActionsRequestedEvent({
        actions: agents.map(({ callId, name }) => ({
          callId,
          input: { message: "Look into the checkout spike." },
          kind: "tool-call" as const,
          toolName: name,
        })),
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
      ...agents.map(({ callId, name, taskId }) =>
        createTaskStartedEvent({ callId, kind: "agent", name, taskId, turnId: TURN_ID }),
      ),
    );
    expect(plan()).toMatchObject({ title: "Asking researcher and reviewer", type: "plan" });

    vi.setSystemTime(start + 74_000);
    await emit(
      createTaskSettledEvent({
        callId: RESEARCH_CALL,
        kind: "agent",
        name: "researcher",
        output: { message: "Alice found three incidents. Details follow." },
        status: "completed",
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );
    expect(plan()).toMatchObject({
      tasks: [
        {
          output: {
            elements: [{ elements: [{ text: "Done in 1m 14s: Alice found three incidents." }] }],
          },
        },
        { status: "in_progress" },
      ],
      title: "Waiting on reviewer · 1 of 2 tasks done",
    });

    vi.setSystemTime(start + 180_000);
    await emit(
      createTaskSettledEvent({
        callId: "call_review",
        error: { message: "Bob's review timed out." },
        kind: "agent",
        name: "reviewer",
        status: "failed",
        taskId: "reviewer-p3x8vd",
        turnId: TURN_ID,
      }),
      TURN_COMPLETED,
    );
    expect(plan()).toMatchObject({
      tasks: [
        {},
        {
          output: {
            elements: [{ elements: [{ text: "Failed after 3m: Bob's review timed out." }] }],
          },
        },
      ],
      title: "Finished 2 tasks in 3m: 1 failed",
    });

    const blockIds = new Set(
      cardCalls().map((call) => (call.body["blocks"] as BlockKitBlock[])[0]!["block_id"]),
    );
    expect([...blockIds]).toEqual([`eve_task_card_${TURN_ID}`]);
  });

  it("finishes a card and posts a new one when an open turn starts tasks after its earlier ones settled", async () => {
    const followUp = "call_follow_up";
    const { cardCalls, emit } = slackThread();
    await emit(...TWO_TASKS_STARTED, ...BOTH_TASKS_SETTLED);
    const firstCardTs = cardCalls().at(-1)!.body["ts"];

    // The person keeps talking while the turn is open, and the turn starts more work.
    await emit(
      createActionsRequestedEvent({
        actions: [
          {
            callId: followUp,
            input: { message: "Check whether Bob's rollback fixed checkout." },
            kind: "tool-call",
            toolName: "researcher",
          },
        ],
        presentation: {
          [followUp]: { label: "researcher: Check whether Bob's rollback fixed checkout" },
        },
        sequence: 1,
        stepIndex: 2,
        turnId: TURN_ID,
      }),
      createTaskStartedEvent({
        callId: followUp,
        kind: "agent",
        name: "researcher",
        taskId: "researcher-9w4n2c",
        turnId: TURN_ID,
      }),
    );

    const [closed, opened] = cardCalls().slice(-2);
    expect(closed).toMatchObject({
      body: { blocks: [{ title: "Finished 2 tasks: 1 failed", type: "plan" }], ts: firstCardTs },
      operation: "chat.update",
    });
    expect(opened!.operation).toBe("chat.postMessage");
    expect(opened!.body["blocks"]).toEqual([
      expect.objectContaining({
        status: "in_progress",
        title: "researcher: Check whether Bob's rollback fixed checkout",
        type: "task_card",
      }),
    ]);
  });

  it("shows a failure without its error text outside private conversations", async () => {
    const { cardCalls, emit } = slackThread({ state: { ...THREAD, audience: "public" } });

    await emit(...TWO_TASKS_STARTED, ...BOTH_TASKS_SETTLED);

    const blocks = JSON.stringify(cardCalls().at(-1)!.body["blocks"]);
    expect(blocks).not.toContain("Rate limited");
    expect(cardCalls().at(-1)!.body["blocks"]).toMatchObject([
      {
        tasks: [
          { status: "complete" },
          { output: { elements: [{ elements: [{ text: "Failed" }] }] } },
        ],
      },
    ]);
  });

  it("shows a task blocked on a person until its request resolves", async () => {
    const approval = createInputRequestedEvent({
      requests: [
        {
          action: { callId: "child_deploy", input: {}, kind: "tool-call", toolName: "promote" },
          kind: "tool-approval",
          prompt: "Promote storefront to production?",
          requestId: "approval-1",
        },
      ],
      sequence: 3,
      stepIndex: 0,
      taskId: "deploy-4hd8sa",
      turnId: TURN_ID,
    });
    const approved = createInputResolvedEvent({
      resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approval-1" }],
      sequence: 3,
      stepIndex: 0,
      turnId: TURN_ID,
    });
    const card = async (audience: string) => {
      const thread = slackThread({ state: { ...THREAD, audience } });
      await thread.emit(...TWO_TASKS_STARTED, approval);
      const blocked = thread.cardCalls().at(-1)!.body["blocks"];
      await thread.emit(approved);
      return { blocked, resolved: thread.cardCalls().at(-1)!.body["blocks"] };
    };

    const shared = await card("public");
    expect(shared.blocked).toMatchObject([
      {
        tasks: [
          {
            details: { elements: [{ elements: [{ text: "Waiting for approval" }] }] },
            status: "in_progress",
            title: "Deploy storefront",
          },
          { status: "in_progress" },
        ],
        title: "Waiting for approval",
      },
    ]);
    expect(shared.resolved).toMatchObject([{ title: "Working on 2 tasks" }]);
    expect(JSON.stringify(shared.resolved)).not.toContain("Waiting for approval");

    const direct = await card("private");
    expect(JSON.stringify(direct.blocked)).toContain(
      "Waiting for approval: Promote storefront to production?",
    );
  });

  it("posts the card again when someone deleted it", async () => {
    const { cardCalls, emit } = slackThread({
      reply: (operation) =>
        operation === "chat.update" ? { error: "message_not_found", ok: false } : undefined,
    });

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!, BOTH_TASKS_SETTLED[0]!);

    expect(cardCalls().map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.postMessage",
    ]);
  });

  it("tries a failed write once more, then again on the turn's next change", async () => {
    vi.useFakeTimers();
    // The card's first post and its retry both fail.
    let posts = 0;
    const { cardCalls, emit } = slackThread({
      reply: (operation) =>
        operation === "chat.postMessage" && ++posts <= 2
          ? { error: "ratelimited", ok: false }
          : undefined,
    });

    const starting = emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);
    await vi.runAllTimersAsync();
    await starting;
    await emit(BOTH_TASKS_SETTLED[0]!);

    expect(cardCalls().map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.postMessage",
      "chat.postMessage",
    ]);
  });

  it("keeps the card current when a renderer replaces eve's task handlers", async () => {
    const { cardCalls, emit } = slackThread({
      renderers: [{ events: { async "task.started"() {}, async "task.settled"() {} } }],
    });

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!, BOTH_TASKS_SETTLED[0]!);

    expect(cardCalls().at(-1)!.body).toMatchObject({
      blocks: [{ status: "complete", title: "Deploy storefront", type: "task_card" }],
    });
  });

  it("builds an authored task card on eve's default card", async () => {
    const { cardCalls, emit } = slackThread({
      renderers: [
        {
          taskCard(view, next) {
            const card = next(view);
            if (card === null) return null;
            const footer = { elements: [{ text: view.turnId, type: "mrkdwn" }], type: "context" };
            return { ...card, blocks: [...card.blocks, footer] };
          },
        },
      ],
    });

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);

    expect(cardCalls()[0]!.body["blocks"]).toMatchObject([
      { type: "task_card" },
      { elements: [{ text: TURN_ID }], type: "context" },
    ]);
  });

  it("lets an app show its own plan tool's checklist ahead of eve's task rows", async () => {
    // What an app writes: its own `plan` tool, rendered from the call's input.
    const status = {
      completed: "complete",
      failed: "error",
      pending: "pending",
      working: "in_progress",
    };
    const planRenderer = defineSlackRenderer({
      taskCard(view, next) {
        const card = next(view);
        const plan = view.actions.filter((action) => action.name === "plan").at(-1);
        const items = plan?.input?.["items"] as
          | { status: keyof typeof status; title: string }[]
          | undefined;
        if (items === undefined) return card;
        // eve's card is one `plan` block, or one `task_card` block for a single task.
        const [block] = card?.blocks ?? [];
        const taskRows: BlockKitBlock[] =
          block === undefined
            ? []
            : block["type"] === "plan"
              ? (block["tasks"] as BlockKitBlock[])
              : [block];
        const planRows = items.map((item, index) => ({
          status: status[item.status],
          task_id: `plan_${String(index)}`,
          title: item.title,
        }));
        const tasks = [...planRows, ...taskRows.map(({ type: _type, ...row }) => row)];
        return { blocks: [{ tasks, title: "Plan", type: "plan" }], text: "Plan" };
      },
    });
    const { cardCalls, emit } = slackThread({ renderers: [planRenderer] });

    await emit(
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_plan",
            input: {
              items: [
                { status: "completed", title: "Read the incident report" },
                { status: "working", title: "Check recent deploys" },
                { status: "pending", title: "Write up the cause" },
              ],
            },
            kind: "tool-call",
            toolName: "plan",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
    );
    expect(cardCalls()[0]!.body["blocks"]).toMatchObject([
      { tasks: [{ title: "Read the incident report" }, {}, {}], type: "plan" },
    ]);

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);

    expect(cardCalls().at(-1)!.body["blocks"]).toMatchObject([
      {
        tasks: [
          { status: "complete", title: "Read the incident report" },
          { status: "in_progress", title: "Check recent deploys" },
          { status: "pending", title: "Write up the cause" },
          { status: "in_progress", title: "Deploy storefront" },
        ],
        type: "plan",
      },
    ]);
  });

  it("posts no default card for a turn whose tool calls start no task", async () => {
    const { cardCalls, emit } = slackThread();

    await emit(
      createActionsRequestedEvent({
        actions: [{ callId: "call_logs", input: {}, kind: "tool-call", toolName: "logs" }],
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
      TURN_COMPLETED,
    );

    expect(cardCalls()).toEqual([]);
  });

  it("posts no card in a schedule's session, which posts only its final reply", async () => {
    const { cardCalls, emit } = slackThread({ schedule: true });

    await emit(...TWO_TASKS_STARTED);

    expect(cardCalls()).toEqual([]);
  });
});
