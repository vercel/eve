import { afterEach, describe, expect, it, vi } from "vitest";

import { reduceProgressCommand, createProgressSnapshot } from "#execution/session-progress.js";
import {
  activityMessages,
  buildSlackProgressRenderers,
  slackActivityProgress,
  slackStatusProgress,
} from "#public/channels/slack/progress.js";

function snapshot() {
  return reduceProgressCommand(createProgressSnapshot(), {
    commandId: "structural",
    events: [
      {
        eventId: "root",
        kind: "turn",
        turn: {
          id: "turn:root:t1",
          phase: "running",
          sequence: 0,
          startedAt: "2026-08-19T12:00:00.000Z",
        },
      },
      {
        eventId: "child",
        kind: "turn",
        turn: {
          groupId: "turn:root:t1",
          id: "turn:child:t1",
          phase: "running",
          sequence: 0,
          startedAt: "2026-08-19T12:00:01.000Z",
        },
      },
      {
        entity: {
          groupId: "turn:root:t1",
          id: "action:child:c1",
          kind: "tool",
          label: "Read <secrets> & verify",
          phase: "running",
          turnId: "turn:child:t1",
        },
        eventId: "tool",
        kind: "entity",
      },
    ],
    kind: "progress",
    version: 1,
  });
}

describe("Slack activity progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups descendant work under the originating root turn and escapes mrkdwn controls", () => {
    expect(activityMessages(snapshot())).toEqual(
      new Map([["turn:root:t1", "• Read &lt;secrets&gt; &amp; verify"]]),
    );
  });

  it("creates one metadata-tagged message and updates it in place", async () => {
    const requests: Array<{ operation: string; body: URLSearchParams }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const operation = String(url).split("/").at(-1)!;
        const body = new URLSearchParams(String(init?.body ?? ""));
        requests.push({ body, operation });
        if (operation === "conversations.replies") {
          return Response.json({ ok: true, messages: [] });
        }
        return Response.json({ ok: true, ts: "1700.1" });
      }),
    );
    const [renderer] = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    });
    const state = await renderer!.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: snapshot(),
      state: undefined,
    });
    const completed = reduceProgressCommand(snapshot(), {
      commandId: "done",
      events: [
        {
          entity: {
            groupId: "turn:root:t1",
            id: "action:child:c1",
            kind: "tool",
            label: "Read secrets",
            phase: "completed",
            turnId: "turn:child:t1",
          },
          eventId: "tool-done",
          kind: "entity",
        },
      ],
      kind: "progress",
      version: 1,
    });
    await renderer!.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: completed,
      state,
    });

    expect(requests.map((request) => request.operation)).toEqual([
      "conversations.replies",
      "chat.postMessage",
      "chat.update",
    ]);
    expect(requests[1]?.body.get("metadata")).toContain("eve_progress");
    expect(requests[2]?.body.get("ts")).toBe("1700.1");
  });

  it("reposts a deleted activity message", async () => {
    const operations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const operation = String(url).split("/").at(-1)!;
        operations.push(operation);
        if (operation === "chat.update")
          return Response.json({ error: "message_not_found", ok: false });
        return Response.json({ ok: true, ts: "replacement" });
      }),
    );
    const [renderer] = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackActivityProgress()],
    });
    const state = { messages: { "turn:root:t1": { text: "old", ts: "deleted" } } };
    await expect(
      renderer!.render({
        destination: { channelId: "C1", threadTs: "T1" },
        snapshot: snapshot(),
        state,
      }),
    ).resolves.toEqual({
      messages: {
        "turn:root:t1": { text: "• Read &lt;secrets&gt; &amp; verify", ts: "replacement" },
      },
    });
    expect(operations).toEqual(["chat.update", "chat.postMessage"]);
  });

  it("recovers message identity from Slack metadata and composes with status", async () => {
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
                  event_payload: { group_id: "turn:root:t1" },
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
    const renderers = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackStatusProgress(), slackActivityProgress()],
    });
    for (const renderer of renderers) {
      await renderer.render({
        destination: { channelId: "C1", threadTs: "T1" },
        snapshot: snapshot(),
        state: undefined,
      });
    }

    expect(operations).toContain("assistant.threads.setStatus");
    expect(operations).toContain("chat.update");
    expect(operations).not.toContain("chat.postMessage");
  });
});
