import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ScheduleIdKey, SessionKey } from "#context/keys.js";
import type { SessionEventsPage } from "#execution/read-session-events.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createAgentStartedEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createMessageAppendedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  stampMessageStreamEvent as stamp,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { defineSlackRenderer, type SlackRenderer } from "#public/channels/slack/renderers.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import type { TaskCardAgentWork } from "#channel/task-card.js";

/** What each agent session's stream holds, which the lane reads from. */
const sessionStreams = vi.hoisted(() => new Map<string, unknown[]>());
const sessionReads = vi.hoisted(() => [] as string[]);
/** Where each read of a remote agent's session went. */
const remoteReads = vi.hoisted(() => new Map<string, unknown>());
vi.mock("#execution/read-session-events.js", () => ({
  async readSessionEvents(input: {
    readonly limit: number;
    readonly remote?: unknown;
    readonly sessionId: string;
    readonly startIndex: number;
  }): Promise<SessionEventsPage> {
    sessionReads.push(input.sessionId);
    if (input.remote !== undefined) remoteReads.set(input.sessionId, input.remote);
    const stream = (sessionStreams.get(input.sessionId) ?? []) as MessageStreamEvent[];
    const events = stream.slice(input.startIndex, input.startIndex + input.limit);
    const nextIndex = input.startIndex + events.length;
    return { caughtUp: nextIndex >= stream.length, events, nextIndex };
  },
}));

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
  const calls: Array<{
    readonly body: Record<string, unknown>;
    readonly operation: string;
    response?: Record<string, unknown>;
  }> = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const operation = String(input).split("/").at(-1)!;
    const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
    const call = {
      body: decodeSlackApiBody(init?.body ?? "", contentType) as Record<string, unknown>,
      operation,
      response: undefined as Record<string, unknown> | undefined,
    };
    calls.push(call);
    const ts = `1700000009.00010${String(calls.length)}`;
    call.response = reply(operation, calls.length - 1) ?? { ok: true, ts };
    return Response.json(call.response);
  });
  return { calls, fetch };
}

/**
 * A root session's Slack channel in a thread. `emit` delivers events the way
 * the session does, keeping the channel's state between events, then runs the
 * channel's render lane once, as the session does after the step commits.
 * `render` runs the lane again, as its wake-up does.
 */
function slackThread(
  input: {
    readonly renderers?: readonly SlackRenderer[];
    readonly refreshIntervalMs?: number;
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
    taskCards: { refreshIntervalMs: input.refreshIntervalMs },
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
  let lane: unknown;
  const render = async () => {
    const result = await contextStorage.run(session, () =>
      adapter.renderLane!.render({ channel: adapterCtx, lane }),
    );
    lane = result.lane;
    return result;
  };
  const emit = async (...events: UnstampedMessageStreamEvent[]) => {
    for (const event of events) {
      await contextStorage.run(session, () => callAdapterEventHandler(adapter, event, adapterCtx));
    }
    return await render();
  };
  // Card writes carry a task card or plan block; other posts, such as an approval, don't.
  const cardCalls = () =>
    calls.filter((call) => /"type":"(task_card|plan)"/.test(JSON.stringify(call.body["blocks"])));
  return { calls, cardCalls, emit, render };
}

/** A root turn that starts a deploy tool task and a researcher agent task. */
const TWO_TASKS_STARTED: readonly UnstampedMessageStreamEvent[] = [
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

const BOTH_TASKS_SETTLED: readonly UnstampedMessageStreamEvent[] = [
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

/** Appends one of an agent's own events to its session's stream. */
function agentEvent(sessionId: string, event: UnstampedMessageStreamEvent): void {
  sessionStreams.set(sessionId, [...(sessionStreams.get(sessionId) ?? []), stamp(event)]);
}

function agentToolCall(sessionId: string, callId: string, label: string): void {
  agentEvent(
    sessionId,
    createActionsRequestedEvent({
      actions: [{ callId, input: {}, kind: "tool-call", toolName: "read_doc" }],
      presentation: { [callId]: { label } },
      sequence: 1,
      stepIndex: 0,
      turnId: "child_turn",
    }),
  );
}

/** The labels eve's rows show in `details`, by row, from the card eve last wrote. */
function rowDetails(calls: readonly { readonly body: Record<string, unknown> }[]): unknown[] {
  const [block] = calls.at(-1)!.body["blocks"] as BlockKitBlock[];
  const rows = block!["type"] === "plan" ? (block!["tasks"] as BlockKitBlock[]) : [block!];
  return rows.map(
    (row) =>
      (
        (row["details"] as BlockKitBlock | undefined)?.["elements"] as BlockKitBlock[] | undefined
      )?.[0]?.["elements"],
  );
}

// What an app writes: each agent task's latest three tool calls, one per line, under its row.
const agentSteps = defineSlackRenderer({
  async taskCard(view, next) {
    const card = await next(view);
    const [block] = card?.blocks ?? [];
    if (card === null || block === undefined) return card;
    // eve's card is one `plan` block, or one `task_card` block for a single task, with rows in task order.
    const rows = block["type"] === "plan" ? (block["tasks"] as BlockKitBlock[]) : [block];
    const withSteps = await Promise.all(
      rows.map(async (row, index) => {
        const work = await view.tasks[index]?.agent?.work();
        const text = work?.actions
          .slice(-3)
          .map((action) => action.title)
          .join("\n");
        if (!text || row["details"] !== undefined) return row;
        return {
          ...row,
          details: {
            elements: [{ elements: [{ text, type: "text" }], type: "rich_text_section" }],
            type: "rich_text",
          },
        };
      }),
    );
    return {
      ...card,
      blocks: block["type"] === "plan" ? [{ ...block, tasks: withSteps }] : withSteps,
    };
  },
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  sessionStreams.clear();
  sessionReads.length = 0;
  remoteReads.clear();
});

describe("Slack task card", () => {
  it("posts one live card for a turn's tasks, then updates it in place until the turn ends", async () => {
    const { cardCalls, emit } = slackThread();

    await emit(...TWO_TASKS_STARTED);

    // Both tasks started before the lane rendered, so one post shows both.
    expect(cardCalls().map((call) => call.operation)).toEqual(["chat.postMessage"]);
    expect(cardCalls()[0]!.body).toMatchObject({
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
      channel: "C01",
      text: "Working on 2 tasks: Deploy storefront, researcher: Find the incidents behind the checkout spike",
      thread_ts: "1700000000.000001",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    const cardTs = cardCalls()[0]!.response?.["ts"];
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

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);
    await emit(BOTH_TASKS_SETTLED[0]!);

    expect(cardCalls().map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.postMessage",
    ]);
  });

  it("tries a failed write once more in the same render", async () => {
    vi.useFakeTimers();
    let posts = 0;
    const { cardCalls, emit } = slackThread({
      reply: (operation) =>
        operation === "chat.postMessage" && ++posts === 1
          ? { error: "ratelimited", ok: false }
          : undefined,
    });

    const rendering = emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);
    await vi.runAllTimersAsync();
    const rendered = await rendering;
    await emit(BOTH_TASKS_SETTLED[0]!);

    // A session that ends right after this render still gets its card.
    expect(rendered.wakeInMs).toBeUndefined();
    expect(cardCalls().map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.postMessage",
      "chat.update",
    ]);
  });

  it("backs off a card Slack keeps refusing, then stops until the card changes", async () => {
    vi.useFakeTimers();
    let refusing = true;
    const { cardCalls, emit, render } = slackThread({
      reply: (operation) =>
        operation === "chat.postMessage" && refusing
          ? { error: "not_in_channel", ok: false }
          : undefined,
    });
    const settle = async (rendering: ReturnType<typeof render>) => {
      await vi.runAllTimersAsync();
      return await rendering;
    };

    const wakes = [await settle(emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!))];
    for (let renders = 1; renders < 5; renders += 1) wakes.push(await settle(render()));

    expect(wakes.map((result) => result.wakeInMs)).toEqual([
      5_000,
      10_000,
      20_000,
      undefined,
      undefined,
    ]);
    // Two attempts in each of four renders, then none.
    expect(cardCalls()).toHaveLength(8);

    refusing = false;
    await settle(emit(BOTH_TASKS_SETTLED[0]!));
    expect(cardCalls().at(-1)!.operation).toBe("chat.postMessage");
    expect(cardCalls()).toHaveLength(9);
  });

  it("keeps the card current when a renderer replaces eve's task handlers", async () => {
    const { cardCalls, emit } = slackThread({
      renderers: [{ events: { async "task.started"() {}, async "task.settled"() {} } }],
    });

    await emit(TWO_TASKS_STARTED[0]!, TWO_TASKS_STARTED[1]!);
    await emit(BOTH_TASKS_SETTLED[0]!);

    expect(cardCalls().at(-1)!.body).toMatchObject({
      blocks: [{ status: "complete", title: "Deploy storefront", type: "task_card" }],
    });
  });

  it("builds an authored task card on eve's default card", async () => {
    const { cardCalls, emit } = slackThread({
      renderers: [
        {
          async taskCard(view, next) {
            const card = await next(view);
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
      async taskCard(view, next) {
        const card = await next(view);
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

  it("reads an agent task's own events when a card asks for them", async () => {
    const { cardCalls, emit, render } = slackThread({
      refreshIntervalMs: 15_000,
      renderers: [agentSteps],
    });
    const child = "session_researcher";
    const shownSteps = () => {
      const [plan] = cardCalls().at(-1)!.body["blocks"] as BlockKitBlock[];
      return ((plan!["tasks"] as BlockKitBlock[])[1]!["details"] as BlockKitBlock)["elements"];
    };
    const childToolCall = (callId: string, label: string) =>
      sessionStreams.set(child, [
        ...(sessionStreams.get(child) ?? []),
        stamp(
          createActionsRequestedEvent({
            actions: [{ callId, input: {}, kind: "tool-call", toolName: "read_doc" }],
            presentation: { [callId]: { label } },
            sequence: 1,
            stepIndex: 0,
            turnId: "child_turn",
          }),
        ),
      ]);

    // The agent works after the root starts its task.
    await emit(...TWO_TASKS_STARTED);
    childToolCall("child_read", "Reading the INC-2291 postmortem");
    const opened = await emit(
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        sessionId: child,
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );
    // The render that first asks for the agent's events already shows them.
    expect(shownSteps()).toMatchObject([
      { elements: [{ text: "Reading the INC-2291 postmortem" }] },
    ]);
    expect(opened.wakeInMs).toBe(15_000);

    // Nothing new in the agent's session writes nothing.
    const writes = cardCalls().length;
    await render();
    expect(cardCalls()).toHaveLength(writes);

    childToolCall("child_timeline", "Checking the deploy timeline");
    await render();
    expect(shownSteps()).toMatchObject([
      { elements: [{ text: "Reading the INC-2291 postmortem\nChecking the deploy timeline" }] },
    ]);

    // Once the agent settles, the card keeps its steps but stops refreshing.
    const settled = await emit(...BOTH_TASKS_SETTLED, TURN_COMPLETED);
    expect(settled.wakeInMs).toBeUndefined();
  });

  it("reads a remote agent task's session from where the agent runs", async () => {
    const { cardCalls, emit } = slackThread({ renderers: [agentSteps] });
    const child = "session_remote_researcher";
    const remote = { resolverId: "researcher", url: "https://research.example.com" };

    await emit(...TWO_TASKS_STARTED);
    agentToolCall(child, "child_read", "Reading the INC-2291 postmortem");
    await emit(
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        remote,
        sessionId: child,
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );

    expect(remoteReads.get(child)).toEqual({ name: "researcher", ...remote });
    expect(rowDetails(cardCalls())[1]).toEqual([
      expect.objectContaining({ text: "Reading the INC-2291 postmortem" }),
    ]);
  });

  it("keeps reading an agent session that is behind until it reaches the tail", async () => {
    const { cardCalls, emit, render } = slackThread({ renderers: [agentSteps] });
    const child = "session_researcher";
    const delta = createMessageAppendedEvent({
      messageDelta: "…",
      sequence: 1,
      stepIndex: 0,
      turnId: "child_turn",
    });
    await emit(...TWO_TASKS_STARTED);
    // Streamed deltas fill more than one render's reads before the agent's later tool call.
    agentToolCall(child, "child_read", "Reading the INC-2291 postmortem");
    for (let index = 0; index < 1_100; index += 1) agentEvent(child, delta);
    agentToolCall(child, "child_timeline", "Checking the deploy timeline");

    const first = await emit(
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        sessionId: child,
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );
    expect(rowDetails(cardCalls())[1]).toMatchObject([{ text: "Reading the INC-2291 postmortem" }]);
    // No refresh interval is set, yet the lane comes back for the rest.
    expect(first.wakeInMs).toBe(1_000);

    const caughtUp = await render();
    expect(rowDetails(cardCalls())[1]).toMatchObject([
      { text: "Reading the INC-2291 postmortem\nChecking the deploy timeline" },
    ]);
    expect(caughtUp.wakeInMs).toBeUndefined();
  });

  it("reads every agent session a card asks for, not only the first few", async () => {
    const { cardCalls, emit } = slackThread({ renderers: [agentSteps] });
    const agents = Array.from({ length: 9 }, (_unused, index) => ({
      callId: `call_agent_${String(index)}`,
      sessionId: `session_agent_${String(index)}`,
      taskId: `researcher-${String(index)}`,
    }));

    await emit(
      createActionsRequestedEvent({
        actions: agents.map((agent) => ({
          callId: agent.callId,
          input: { message: "Look into it" },
          kind: "tool-call" as const,
          toolName: "researcher",
        })),
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
      ...agents.map((agent) =>
        createTaskStartedEvent({
          callId: agent.callId,
          kind: "agent",
          name: "researcher",
          taskId: agent.taskId,
          turnId: TURN_ID,
        }),
      ),
    );
    for (const agent of agents) {
      agentToolCall(agent.sessionId, "child_read", `Step ${agent.callId}`);
    }
    await emit(
      ...agents.map((agent) =>
        createAgentStartedEvent({
          callId: agent.callId,
          name: "researcher",
          parentSessionId: "session_root",
          sessionId: agent.sessionId,
          taskId: agent.taskId,
          turnId: TURN_ID,
        }),
      ),
    );

    expect(rowDetails(cardCalls())).toEqual(
      agents.map((agent) => [expect.objectContaining({ text: `Step ${agent.callId}` })]),
    );
  });

  it("doesn't let settled agents' sessions starve a working agent's reads", async () => {
    const { cardCalls, emit, render } = slackThread({ renderers: [agentSteps] });
    // More agents than one render reads; the one still working comes last in the card.
    const agents = Array.from({ length: 33 }, (_unused, index) => ({
      callId: `call_agent_${String(index)}`,
      sessionId: `session_agent_${String(index)}`,
      taskId: `researcher-${String(index)}`,
    }));
    const working = agents.at(-1)!;
    await emit(
      createActionsRequestedEvent({
        actions: agents.map((agent) => ({
          callId: agent.callId,
          input: { message: "Look into it" },
          kind: "tool-call" as const,
          toolName: "researcher",
        })),
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
      ...agents.map((agent) =>
        createTaskStartedEvent({
          callId: agent.callId,
          kind: "agent",
          name: "researcher",
          taskId: agent.taskId,
          turnId: TURN_ID,
        }),
      ),
    );
    for (const agent of agents) {
      agentToolCall(agent.sessionId, "child_read", `Step ${agent.callId}`);
    }
    await emit(
      ...agents.map((agent) =>
        createAgentStartedEvent({
          callId: agent.callId,
          name: "researcher",
          parentSessionId: "session_root",
          sessionId: agent.sessionId,
          taskId: agent.taskId,
          turnId: TURN_ID,
        }),
      ),
      ...agents
        .filter((agent) => agent !== working)
        .map((agent) =>
          createTaskSettledEvent({
            callId: agent.callId,
            kind: "agent",
            name: "researcher",
            output: "Done.",
            status: "completed",
            taskId: agent.taskId,
            turnId: TURN_ID,
          }),
        ),
    );
    await render();
    await render();

    expect(rowDetails(cardCalls()).at(-1)).toEqual([
      expect.objectContaining({ text: `Step ${working.callId}` }),
    ]);
  });

  it("rolls an agent's own tool calls up with their status, keeping only the newest", async () => {
    const works: TaskCardAgentWork[] = [];
    const { emit } = slackThread({
      renderers: [
        {
          async taskCard(view, next) {
            const work = await view.tasks.find((task) => task.agent !== undefined)?.agent?.work();
            if (work !== undefined) works.push(work);
            return await next(view);
          },
        },
      ],
    });
    const child = "session_researcher";
    await emit(...TWO_TASKS_STARTED);
    for (let index = 0; index < 25; index += 1) {
      agentToolCall(child, `child_${String(index)}`, `Step ${String(index)}`);
    }
    agentEvent(
      child,
      createActionResultEvent({
        result: { callId: "child_24", kind: "tool-result", output: "done", toolName: "read_doc" },
        sequence: 2,
        stepIndex: 0,
        turnId: "child_turn",
      }),
    );

    await emit(
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        sessionId: child,
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );

    const work = works.at(-1)!;
    expect(work.earlierActions).toBe(5);
    expect(work.actions).toHaveLength(20);
    expect(work.actions[0]).toMatchObject({ status: "working", title: "Step 5" });
    expect(work.actions.at(-1)).toMatchObject({ status: "completed", title: "Step 24" });
    expect(work.actions.at(-1)).not.toHaveProperty("input");
  });

  it("rejects a refresh interval under a second", () => {
    expect(() => slackChannel({ taskCards: { refreshIntervalMs: 100 } })).toThrow(
      /at least 1000 milliseconds; received 100/u,
    );
  });

  it("reads no agent session unless a card asks for its events", async () => {
    const { emit } = slackThread({ refreshIntervalMs: 15_000 });

    const rendered = await emit(
      ...TWO_TASKS_STARTED,
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        sessionId: "session_researcher",
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );

    expect(sessionReads).toEqual([]);
    expect(rendered.wakeInMs).toBeUndefined();
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
    const readsEvents = defineSlackRenderer({
      async taskCard(view, next) {
        for (const task of view.tasks) await task.agent?.work();
        return await next(view);
      },
    });
    const { cardCalls, emit } = slackThread({
      refreshIntervalMs: 15_000,
      renderers: [readsEvents],
      schedule: true,
    });

    const rendered = await emit(
      ...TWO_TASKS_STARTED,
      createAgentStartedEvent({
        callId: RESEARCH_CALL,
        name: "researcher",
        parentSessionId: "session_root",
        sessionId: "session_researcher",
        taskId: "researcher-7k2m9q",
        turnId: TURN_ID,
      }),
    );

    expect(cardCalls()).toEqual([]);
    // With no card to show it on, eve doesn't read the agent's session either.
    expect(sessionReads).toEqual([]);
    expect(rendered.wakeInMs).toBeUndefined();
  });
});
