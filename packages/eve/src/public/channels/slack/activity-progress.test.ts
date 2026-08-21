import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgressSnapshot, reduceProgressBatch } from "#execution/session-progress.js";
import {
  activityMessages,
  buildSlackProgressRenderers,
  slackActivityProgress,
  slackStatusProgress,
} from "#public/channels/slack/progress.js";

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
  return reduceProgressBatch(createProgressSnapshot(), {
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

describe("Slack activity progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives one nested artifact per root turn and escapes untrusted text", () => {
    expect(activityMessages(snapshot())).toEqual(
      new Map([
        [
          "turn",
          [
            "• Working",
            "  • research &lt;team&gt;",
            "    • tester &amp; reviewer",
            "      • search &lt;web&gt;",
          ].join("\n"),
        ],
      ]),
    );
  });

  it("keeps temporarily orphaned nested work renderable", () => {
    const orphan = reduceProgressBatch(createProgressSnapshot(), {
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
    const requests: Array<{ body: URLSearchParams; operation: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const operation = String(url).split("/").at(-1)!;
        requests.push({ body: new URLSearchParams(String(init?.body ?? "")), operation });
        if (operation === "conversations.replies") return Response.json({ ok: true, messages: [] });
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const renderer = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    })[0]!;
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });
    const settled = reduceProgressBatch(snapshot(), {
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
    expect(activityMessages(settled).get("turn")).toContain("– search &lt;web&gt;");
    expect(requests.map((request) => request.operation)).toEqual([
      "conversations.replies",
      "chat.postMessage",
      "chat.update",
    ]);
    expect(requests[1]?.body.get("metadata")).toContain('"root_turn_id":"turn"');
    expect(requests[2]?.body.get("ts")).toBe("1700.1");
  });

  it("recreates a deleted activity message", async () => {
    const operations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const operation = String(url).split("/").at(-1)!;
        operations.push(operation);
        return operation === "chat.update"
          ? Response.json({ error: "message_not_found", ok: false })
          : Response.json({ ok: true, ts: "1700.2" });
      }),
    );
    const renderer = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    })[0]!;
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: { messages: { turn: { text: "old", ts: "1700.1" } } },
    });
    expect(operations).toEqual(["chat.update", "chat.postMessage"]);
    expect(state).toMatchObject({ messages: { turn: { ts: "1700.2" } } });
  });

  it("recovers provider identity from message metadata", async () => {
    const operations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const operation = String(url).split("/").at(-1)!;
        operations.push(operation);
        if (operation === "conversations.replies") {
          return Response.json({
            messages: [
              {
                metadata: {
                  event_payload: { root_turn_id: "turn" },
                  event_type: "eve_progress",
                },
                text: "old",
                ts: "1700.1",
              },
            ],
            ok: true,
          });
        }
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const renderer = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    })[0]!;
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });
    expect(operations).toEqual(["conversations.replies", "chat.update"]);
  });

  it("paginates metadata recovery until a matching activity message is found", async () => {
    const repliesBodies: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const operation = String(url).split("/").at(-1)!;
        if (operation === "conversations.replies") {
          const body = new URLSearchParams(String(init?.body ?? ""));
          repliesBodies.push(body);
          if (body.get("cursor") === null) {
            return Response.json({
              messages: [],
              ok: true,
              response_metadata: { next_cursor: "page-2" },
            });
          }
          return Response.json({
            messages: [
              {
                metadata: {
                  event_payload: { root_turn_id: "turn" },
                  event_type: "eve_progress",
                },
                text: "old",
                ts: "1700.1",
              },
            ],
            ok: true,
            response_metadata: { next_cursor: "" },
          });
        }
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const renderer = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    })[0]!;
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    expect(repliesBodies.map((body) => body.get("cursor"))).toEqual([null, "page-2"]);
  });

  it("stops recovery when Slack repeats a cursor", async () => {
    const operations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const operation = String(url).split("/").at(-1)!;
        operations.push(operation);
        return operation === "conversations.replies"
          ? Response.json({
              messages: [],
              ok: true,
              response_metadata: { next_cursor: "same" },
            })
          : Response.json({ ok: true, ts: "1700.2" });
      }),
    );
    const renderer = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    })[0]!;
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });

    expect(operations).toEqual([
      "conversations.replies",
      "conversations.replies",
      "chat.postMessage",
    ]);
  });

  it("composes activity and status with isolated renderer state", () => {
    const renderers = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackStatusProgress(), slackActivityProgress()],
    });
    expect(renderers.map((renderer) => renderer.id)).toEqual([
      "slack.status.v1",
      "slack.activity.v1",
    ]);
  });
});
