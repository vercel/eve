import { describe, expect, it, vi } from "vitest";

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
  createTurnStartedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
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
      taskCallIds: [DEPLOY_CALL, RESEARCH_CALL],
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
          description: "Researches incidents.",
          input: { message: "Find the incidents behind the checkout spike\nInclude timelines." },
          kind: "subagent-call",
          name: "researcher",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      ],
      presentation: { [DEPLOY_CALL]: { label: "Deploy storefront" } },
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
  ]);
}

function slackApi() {
  const calls: Array<{ readonly body: Record<string, unknown>; readonly operation: string }> = [];
  const fetch = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const operation = String(input).split("/").at(-1)!;
    const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
    calls.push({
      body: decodeSlackApiBody(init?.body ?? "", contentType) as Record<string, unknown>,
      operation,
    });
    return Response.json({ ok: true, ts: "1700000009.000100" });
  });
  return { calls, fetch };
}

function presenterOf(channel: unknown) {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const presenter = getChannelActivityPresenter(channel.adapter);
  if (presenter === undefined) throw new Error("Expected a task card presenter.");
  return presenter;
}

const THREAD = { channelId: "C01", installationTeamId: null, threadTs: "1700000000.000001" };

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
      blocks: [
        {
          tasks: [
            { status: "in_progress", title: "Deploy storefront" },
            {
              details: {
                elements: [{ elements: [{ text: "Reading INC-2291 postmortem" }] }],
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
      ts: "1700000009.000100",
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
});
