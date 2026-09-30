import { afterEach, describe, expect, it, vi } from "vitest";

import { getChannelActivityPresenter } from "#channel/activity-presenter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { deriveChildWorkIdentity } from "#execution/activity-work.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { projectSessionActivity } from "#execution/session-activity-projection.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import type { ActivitySnapshotV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import {
  createActionsRequestedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { defineSlackRenderer } from "#public/channels/slack/renderers.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

const SESSION_ID = "session_root";
const TURN_ID = "turn_1";
const DEPLOY_CALL = "call_deploy";
const RESEARCH_CALL = "call_research";
let clock = 0;

function stamp(event: UnstampedMessageStreamEvent): MessageStreamEvent {
  clock += 1;
  return {
    ...event,
    meta: { at: new Date(Date.UTC(2026, 8, 30, 12, 0, clock)).toISOString(), id: `evt_${clock}` },
  } as MessageStreamEvent;
}

/** Reduces events as the collector would receive them from each session. */
function observe(
  snapshot: ActivitySnapshotV1,
  events: readonly UnstampedMessageStreamEvent[],
  workIdentity?: ActivityWorkIdentityV1,
): ActivitySnapshotV1 {
  let next = snapshot;
  for (const event of events) {
    const activity = projectSessionActivity({
      event: stamp(event),
      sessionId: workIdentity === undefined ? SESSION_ID : "session_researcher",
      taskCallIds: [DEPLOY_CALL, RESEARCH_CALL, "call_lint"],
      workIdentity,
    });
    next = reduceActivityBatch(next, { events: activity, version: 1 });
  }
  return next;
}

/** A root turn that starts a deploy tool task and a researcher agent task. */
function startTwoTasks(): ActivitySnapshotV1 {
  const started = observe(createActivitySnapshot(), [
    createTurnStartedEvent({ sequence: 1, turnId: TURN_ID }),
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
  ]);
  const rootWork = Object.values(started.work).find((work) => work.kind === "root-turn")!;
  const researcher = deriveChildWorkIdentity({
    callId: RESEARCH_CALL,
    kind: "subagent",
    name: "researcher",
    parentSessionId: SESSION_ID,
    parentTurnId: TURN_ID,
    parentWork: rootWork,
    sessionKey: "0",
  });
  return observe(
    started,
    [
      createTurnStartedEvent({ sequence: 1, turnId: "child_turn" }),
      createActionsRequestedEvent({
        actions: [
          {
            callId: "child_read",
            input: { path: "incidents/2291.md" },
            kind: "tool-call",
            toolName: "read_file",
          },
        ],
        presentation: { child_read: { label: "Reading INC-2291 postmortem" } },
        sequence: 1,
        stepIndex: 0,
        turnId: "child_turn",
      }),
    ],
    researcher,
  );
}

function settleBothTasks(snapshot: ActivitySnapshotV1): ActivitySnapshotV1 {
  return observe(snapshot, [
    createTaskSettledEvent({
      callId: DEPLOY_CALL,
      output: "3 deploys; 14:02 changed the cache TTL\nFull log attached.",
      status: "completed",
      taskId: "deploy-4hd8sa",
      turnId: TURN_ID,
    }),
    createTaskSettledEvent({
      callId: RESEARCH_CALL,
      error: { message: "Rate limited by the incidents API\nRetry after 60s." },
      status: "failed",
      taskId: "researcher-7k2m9q",
      turnId: TURN_ID,
    }),
    createTurnCompletedEvent({ sequence: 2, turnId: TURN_ID }),
  ]);
}

/** A later root turn that starts one lint task. */
function startLint(snapshot: ActivitySnapshotV1): ActivitySnapshotV1 {
  return observe(snapshot, [
    createTurnStartedEvent({ sequence: 3, turnId: "turn_2" }),
    createActionsRequestedEvent({
      actions: [{ callId: "call_lint", input: {}, kind: "tool-call", toolName: "lint" }],
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_2",
    }),
    createTaskStartedEvent({
      callId: "call_lint",
      kind: "tool",
      name: "lint",
      taskId: "lint-2b7x0p",
      turnId: "turn_2",
    }),
  ]);
}

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

function presenterOf(channel: unknown) {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const presenter = getChannelActivityPresenter(channel.adapter);
  if (presenter === undefined) throw new Error("Expected a task card presenter.");
  return presenter;
}

const THREAD = {
  audience: "private",
  channelId: "C01",
  installationTeamId: null,
  threadTs: "1700000000.000001",
};

function defaultPresenter(fetch: typeof globalThis.fetch) {
  return presenterOf(slackChannel({ api: { fetch }, credentials: { botToken: "xoxb-test" } }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack task card", () => {
  it("posts one live card for a turn's tasks, then updates it in place as they settle", async () => {
    const { calls, fetch } = slackApi();
    const presenter = presenterOf(
      slackChannel({ api: { fetch }, credentials: { botToken: "xoxb-test" } }),
    );
    const destination = presenter.destination(THREAD);
    const working = startTwoTasks();

    const posted = await presenter.render({ destination, snapshot: working, state: undefined });

    expect(calls.map((call) => call.operation)).toEqual(["chat.postMessage"]);
    expect(calls[0]!.body).toMatchObject({
      unfurl_links: "false",
      unfurl_media: "false",
      blocks: [
        {
          tasks: [
            { status: "in_progress", title: "Deploy storefront" },
            {
              details: {
                elements: [{ elements: [{ text: "Reading INC-2291 postmortem..." }] }],
              },
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
    });

    const settled = settleBothTasks(working);
    const updated = await presenter.render({ destination, snapshot: settled, state: posted });

    expect(calls.map((call) => call.operation)).toEqual(["chat.postMessage", "chat.update"]);
    expect(calls[1]!.body).toMatchObject({
      blocks: [
        {
          tasks: [
            {
              output: {
                elements: [{ elements: [{ text: "3 deploys; 14:02 changed the cache TTL" }] }],
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
      ts: "1700000009.000101",
    });

    await presenter.render({ destination, snapshot: settled, state: updated });
    expect(calls).toHaveLength(2);
  });

  it("builds an authored task card on eve's default card", async () => {
    const { calls, fetch } = slackApi();
    const presenter = presenterOf(
      slackChannel({
        api: { fetch },
        credentials: { botToken: "xoxb-test" },
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
      }),
    );

    await presenter.render({
      destination: presenter.destination(THREAD),
      snapshot: startTwoTasks(),
      state: undefined,
    });

    expect(calls[0]!.body["blocks"]).toMatchObject([
      { title: "Working on 2 tasks", type: "plan" },
      { elements: [{ text: TURN_ID }], type: "context" },
    ]);
  });

  it("shows a failure without its error text outside private conversations", async () => {
    const { calls, fetch } = slackApi();
    const presenter = defaultPresenter(fetch);

    await presenter.render({
      destination: presenter.destination({ ...THREAD, audience: "public" }),
      snapshot: settleBothTasks(startTwoTasks()),
      state: undefined,
    });

    expect(JSON.stringify(calls[0]!.body["blocks"])).not.toContain("Rate limited");
    expect(calls[0]!.body["blocks"]).toMatchObject([
      {
        tasks: [
          { status: "complete" },
          { output: { elements: [{ elements: [{ text: "Failed" }] }] } },
        ],
      },
    ]);
  });

  it("writes each turn's card on its own, so a failed write never posts the others twice", async () => {
    const { calls, fetch } = slackApi((operation, index) =>
      operation === "chat.postMessage" && index === 1
        ? { error: "ratelimited", ok: false }
        : undefined,
    );
    const presenter = defaultPresenter(fetch);
    const destination = presenter.destination(THREAD);
    const snapshot = startLint(startTwoTasks());

    const first = await presenter.render({ destination, snapshot, state: undefined });
    await presenter.render({ destination, snapshot, state: first });

    const posts = calls.filter((call) => call.operation === "chat.postMessage");
    expect(posts.map((post) => post.body["text"])).toEqual([
      expect.stringContaining("Deploy storefront"),
      expect.stringContaining("lint"),
      expect.stringContaining("lint"),
    ]);
  });

  it("posts the card again when someone deleted it", async () => {
    const { calls, fetch } = slackApi((operation) =>
      operation === "chat.update" ? { error: "message_not_found", ok: false } : undefined,
    );
    const presenter = defaultPresenter(fetch);
    const destination = presenter.destination(THREAD);
    const working = startTwoTasks();

    const posted = await presenter.render({ destination, snapshot: working, state: undefined });
    const reposted = await presenter.render({
      destination,
      snapshot: settleBothTasks(working),
      state: posted,
    });

    expect(calls.map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.postMessage",
    ]);
    expect(reposted).toMatchObject({ cards: { [TURN_ID]: { ts: "1700000009.000103" } } });
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
        const plan = view.actions.findLast((action) => action.name === "plan");
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
        return {
          blocks: [{ tasks, title: "Plan", type: "plan" }],
          text: `Plan: ${items.map((item) => item.title).join(", ")}`,
        };
      },
    });
    const { calls, fetch } = slackApi();
    const presenter = presenterOf(
      slackChannel({
        api: { fetch },
        credentials: { botToken: "xoxb-test" },
        renderers: [planRenderer],
      }),
    );
    const snapshot = observe(createActivitySnapshot(), [
      createTurnStartedEvent({ sequence: 1, turnId: TURN_ID }),
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
      createActionsRequestedEvent({
        actions: [{ callId: DEPLOY_CALL, input: {}, kind: "tool-call", toolName: "deploy" }],
        presentation: { [DEPLOY_CALL]: { label: "Deploy history for storefront" } },
        sequence: 1,
        stepIndex: 1,
        turnId: TURN_ID,
      }),
      createTaskStartedEvent({
        callId: DEPLOY_CALL,
        kind: "tool",
        name: "deploy",
        taskId: "deploy-4hd8sa",
        turnId: TURN_ID,
      }),
    ]);

    await presenter.render({
      destination: presenter.destination(THREAD),
      snapshot,
      state: undefined,
    });

    expect(calls[0]!.body["blocks"]).toMatchObject([
      {
        tasks: [
          { status: "complete", title: "Read the incident report" },
          { status: "in_progress", title: "Check recent deploys" },
          { status: "pending", title: "Write up the cause" },
          { status: "in_progress", title: "Deploy history for storefront" },
        ],
        type: "plan",
      },
    ]);
  });

  it("posts no default card for a turn whose tool calls start no task", async () => {
    const { calls, fetch } = slackApi();
    const presenter = defaultPresenter(fetch);
    const snapshot = observe(createActivitySnapshot(), [
      createTurnStartedEvent({ sequence: 1, turnId: TURN_ID }),
      createActionsRequestedEvent({
        actions: [{ callId: "call_logs", input: {}, kind: "tool-call", toolName: "logs" }],
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
    ]);

    await presenter.render({
      destination: presenter.destination(THREAD),
      snapshot,
      state: undefined,
    });

    expect(calls).toEqual([]);
  });

  it("sets the waiting status again before Slack expires it while tasks work", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 30, 12) });
    const { calls, fetch } = slackApi();
    const presenter = defaultPresenter(fetch);
    const destination = presenter.destination(THREAD);
    const snapshot = startLint(createActivitySnapshot());

    const posted = await presenter.render({ destination, snapshot, state: undefined });
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 1, 30));
    await presenter.render({ destination, snapshot, state: posted });

    expect(calls.map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "assistant.threads.setStatus",
    ]);
    expect(calls[1]!.body).toMatchObject({
      status: "Waiting on lint...",
      thread_ts: THREAD.threadTs,
    });
  });
});
