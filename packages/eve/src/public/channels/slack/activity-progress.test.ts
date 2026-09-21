import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { mockSlack, type MockSlack } from "#internal/testing/mocks/mock-slack.js";
import {
  activityMessages,
  buildSlackActivityRenderers,
  experimental_slackActivityTree,
  experimental_slackActivityStatus,
  selectSlackActivityStatus,
} from "#public/channels/slack/activity.js";

/** Every double this file creates, swept for violations after each test. */
const doubles: MockSlack[] = [];

/**
 * A double registered for the {@link afterEach} sweep below.
 *
 * Renderers swallow transport errors so a failed status update never
 * fails the turn. The sweep is what separates an unstubbed or malformed
 * call from a render that legitimately did not happen.
 */
function slackDouble(): MockSlack {
  const slack = mockSlack();
  doubles.push(slack);
  return slack;
}

afterEach(() => {
  for (const slack of doubles.splice(0)) slack.assertNoViolations();
});

const root = {
  id: "work:root:turn",
  kind: "root-turn" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
};
const child = {
  id: "work:root:turn:child",
  kind: "subagent" as const,
  name: "research <team>",
  parentId: root.id,
  rootSessionId: "root",
  rootTurnId: "turn",
};
const grandchild = {
  id: "work:child:turn:grandchild",
  kind: "remote-agent" as const,
  name: "tester & reviewer",
  parentId: child.id,
  rootSessionId: "root",
  rootTurnId: "turn",
};

function snapshot() {
  return reduceActivityBatch(createActivitySnapshot(), {
    events: [
      { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
      { eventId: "child", kind: "work.started", startedAt: "2026-01-01T00:00:01Z", work: child },
      {
        eventId: "grandchild",
        kind: "work.started",
        startedAt: "2026-01-01T00:00:02Z",
        work: grandchild,
      },
      {
        action: {
          id: `${grandchild.id}:search`,
          kind: "tool",
          name: "search <web>",
          parentWorkId: grandchild.id,
          rootTurnId: "turn",
          stepIndex: 1,
        },
        eventId: "search-started",
        kind: "action.started",
        startedAt: "2026-01-01T00:00:03Z",
      },
    ],
    version: 1,
  });
}

describe("Slack activity activity", () => {
  it("derives one nested artifact per root turn and escapes untrusted text", () => {
    expect(activityMessages(snapshot())).toEqual(
      new Map([
        [
          "turn",
          [
            "```",
            "• Working",
            "└── • research &lt;team&gt;",
            "    └── • tester &amp; reviewer",
            "        └── • search &lt;web&gt;",
            "```",
          ].join("\n"),
        ],
      ]),
    );
  });

  it("uses action labels in the activity tree and status", () => {
    const labeled = reduceActivityBatch(snapshot(), {
      events: [
        {
          actionId: `${grandchild.id}:search`,
          eventId: "search-label",
          kind: "action.label.updated",
          label: "Search Slack docs",
        },
      ],
      version: 1,
    });

    expect(activityMessages(labeled).get("turn")).toContain("Search Slack docs");
    expect(selectSlackActivityStatus(labeled)).toBe("Search Slack docs");

    const completed = reduceActivityBatch(labeled, {
      events: [
        {
          actionId: `${grandchild.id}:search`,
          eventId: "search-complete-label",
          kind: "action.label.updated",
          label: "Found Slack docs",
        },
      ],
      version: 1,
    });
    expect(activityMessages(completed).get("turn")).toContain("Found Slack docs");
    expect(selectSlackActivityStatus(completed)).toBe("Found Slack docs");
  });

  it("keeps task-reporting activity in the originating tree", () => {
    const reportingAction = {
      action: {
        id: "action:work:root:turn:report",
        kind: "tool" as const,
        name: "compose_result",
        parentWorkId: root.id,
        rootTurnId: "turn",
        stepIndex: 0,
      },
      eventId: "report",
      kind: "action.started" as const,
      startedAt: "4",
    };
    const activity = reduceActivityBatch(snapshot(), {
      events: [reportingAction],
      version: 1,
    });

    expect(activityMessages(activity)).toEqual(
      new Map([["turn", expect.stringContaining("compose_result")]]),
    );
  });

  it("renders inherited child tool activity beneath an existing task row", () => {
    const task = {
      id: "work:task",
      kind: "task" as const,
      name: "slack",
      parentId: root.id,
      rootSessionId: "root",
      rootTurnId: "turn",
    };
    const activity = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        { eventId: "root", kind: "work.started", startedAt: "1", work: root },
        { eventId: "task", kind: "work.started", startedAt: "2", work: task },
        {
          action: {
            id: "action:work:task:search",
            kind: "tool",
            name: "search_slack",
            parentWorkId: task.id,
            rootTurnId: "turn",
            stepIndex: 0,
          },
          eventId: "search",
          kind: "action.started",
          startedAt: "3",
        },
      ],
      version: 1,
    });

    expect(activityMessages(activity).get("turn")).toBe(
      "```\n• Working\n└── • slack\n    └── • search_slack\n```",
    );
  });

  it("renders a background task instead of its duplicate initiating tool action", () => {
    const task = {
      callId: "call-background",
      id: "work:background",
      kind: "subagent" as const,
      name: "researcher",
      parentId: root.id,
      rootSessionId: "root",
      rootTurnId: "turn",
    };
    const background = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        { eventId: "root", kind: "work.started", startedAt: "1", work: root },
        {
          action: {
            id: `action:${root.id}:call-background`,
            kind: "tool",
            name: "researcher",
            parentWorkId: root.id,
            rootTurnId: "turn",
            stepIndex: 0,
          },
          eventId: "action",
          kind: "action.started",
          startedAt: "2",
        },
        { eventId: "task", kind: "work.started", startedAt: "3", work: task },
      ],
      version: 1,
    });

    expect(activityMessages(background).get("turn")).toBe("```\n• Working\n└── • researcher\n```");
  });

  it("keeps temporarily orphaned nested work renderable", () => {
    const orphan = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        {
          eventId: "grandchild",
          kind: "work.started",
          startedAt: "2026-01-01T00:00:02Z",
          work: grandchild,
        },
      ],
      version: 1,
    });
    expect(activityMessages(orphan).get("turn")).toContain("tester &amp; reviewer");
  });

  it("creates a metadata-tagged message and updates it in place", async () => {
    const slack = slackDouble();
    slack.allow("conversations.replies").andReturn({ ok: true, messages: [] });
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    slack.allow("chat.update").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityTree()],
    })[0]!;
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });
    const settled = reduceActivityBatch(snapshot(), {
      events: [
        {
          eventId: "settled",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "2026-01-01T00:00:05Z",
          workId: grandchild.id,
        },
      ],
      version: 1,
    });
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: settled,
      state,
    });

    expect(activityMessages(settled).get("turn")).toContain("✓ tester &amp; reviewer");
    expect(activityMessages(settled).get("turn")).toContain("⊘ search &lt;web&gt;");
    expect(slack.calls.map((call) => call.method)).toEqual([
      "conversations.replies",
      "chat.postMessage",
      "chat.update",
    ]);
    expect(slack.bodyOf("chat.postMessage")).toMatchObject({
      metadata: { event_payload: { root_turn_id: "turn" }, event_type: "eve_progress" },
    });

    // One message was posted and then revised in place: the update has to
    // target the ts the post handed back, carrying the settled tree.
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
    expect(slack.bodyOf("chat.update")).toMatchObject({
      channel: "C1",
      ts: "1700.1",
      text: activityMessages(settled).get("turn"),
    });
  });

  it("recreates a deleted activity message", async () => {
    const slack = slackDouble();
    // Slack reporting the remembered ts as gone is the precondition.
    slack.allow("chat.update").andFail("message_not_found");
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.2" });
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityTree()],
    })[0]!;

    // The remembered ts names a message nobody posted, which is exactly
    // what a user deleting the activity message leaves behind.
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: { messages: { turn: { text: "old", ts: "1700.1" } } },
    });

    expect(slack.calls.map((call) => call.method)).toEqual(["chat.update", "chat.postMessage"]);
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
    expect(state).toMatchObject({ messages: { turn: { ts: "1700.2" } } });
  });

  it("passes the installation team to activity message token resolution", async () => {
    const slack = slackDouble();
    slack.allow("conversations.replies").andReturn({ ok: true, messages: [] });
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    const tokenContext = vi.fn(() => "xoxb-team");
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: tokenContext,
      renderers: [experimental_slackActivityTree()],
    })[0]!;

    await renderer.render({
      destination: { channelId: "C1", installationTeamId: "T_INSTALL", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    expect(tokenContext).toHaveBeenCalledWith({ teamId: "T_INSTALL" });
  });

  it("recovers provider identity from message metadata", async () => {
    const slack = slackDouble();
    const activityMessage = {
      metadata: { event_payload: { root_turn_id: "turn" }, event_type: "eve_progress" },
      text: "old",
      thread_ts: "T1",
      ts: "1700.1",
    };
    slack.allow("conversations.replies").andReturn({ ok: true, messages: [activityMessage] });
    slack.allow("chat.update").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityTree()],
    })[0]!;

    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    expect(slack.calls.map((call) => call.method)).toEqual([
      "conversations.replies",
      "chat.update",
    ]);
    // Recovery adopted the existing message rather than posting a second
    // one — chat.postMessage is not even stubbed, so a post would fail.
    expect(slack.bodyOf("chat.update")).toMatchObject({
      ts: "1700.1",
      text: activityMessages(snapshot()).get("turn"),
    });
  });

  it("paginates metadata recovery until a matching activity message is found", async () => {
    const slack = slackDouble();
    const activityMessage = {
      metadata: { event_payload: { root_turn_id: "turn" }, event_type: "eve_progress" },
      text: "old",
      thread_ts: "T1",
      ts: "1700.1",
    };
    // The match lives only on page two, reached by echoing back the
    // cursor page one handed out.
    slack.allow("conversations.replies").andReturnEach([
      {
        ok: true,
        messages: [{ text: "unrelated", thread_ts: "T1", ts: "1700.0" }],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      },
      { ok: true, messages: [activityMessage] },
    ]);
    slack.allow("chat.update").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityTree()],
    })[0]!;

    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    const cursors = slack
      .callsTo("conversations.replies")
      .map((call) => (call.body as { cursor?: string }).cursor);
    // The exact cursor, so the assertion pins that page one's cursor
    // was echoed back and not merely that some cursor was sent.
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(slack.calls.at(-1)?.method).toBe("chat.update");
    expect(slack.bodyOf("chat.update")).toMatchObject({
      ts: "1700.1",
      text: activityMessages(snapshot()).get("turn"),
    });
  });

  it("stops recovery when Slack repeats a cursor", async () => {
    const slack = slackDouble();
    // Slack handing back the same cursor forever. Only two pages are
    // declared, so a third fetch fails loudly instead of spinning.
    const looped = {
      ok: true,
      messages: [{ text: "unrelated", thread_ts: "T1", ts: "1700.0" }],
      has_more: true,
      response_metadata: { next_cursor: "looped-cursor" },
    } as const;
    slack.allow("conversations.replies").andReturnEach([looped, looped]);
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.2" });
    const renderer = buildSlackActivityRenderers({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityTree()],
    })[0]!;

    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    expect(slack.calls.map((call) => call.method)).toEqual([
      "conversations.replies",
      "conversations.replies",
      "chat.postMessage",
    ]);
  });

  it("composes activity and status with isolated renderer state", () => {
    const renderers = buildSlackActivityRenderers({
      botToken: "xoxb-test",
      renderers: [experimental_slackActivityStatus(), experimental_slackActivityTree()],
    });
    expect(renderers.map((renderer) => renderer.id)).toEqual([
      "slack.status.v1",
      "slack.experimental.tree.v1",
    ]);
  });
});
