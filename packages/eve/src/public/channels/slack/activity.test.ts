import { afterEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { getChannelActivityPresentation } from "#channel/activity-renderer.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import {
  buildSlackActivityRenderers,
  selectSlackActivityStatus,
  slackActivityStatus,
} from "#public/channels/slack/activity.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

const root = {
  id: "work:root:turn",
  kind: "root-turn" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
  sessionId: "root",
  turnId: "turn",
};
const child = {
  callId: "child",
  id: "work:root:turn:child",
  kind: "subagent" as const,
  name: "research",
  parentId: root.id,
  rootSessionId: "root",
  rootTurnId: "turn",
};

function snapshot(events: Parameters<typeof reduceActivityBatch>[1]["events"]) {
  return reduceActivityBatch(createActivitySnapshot(), { events, version: 1 });
}

describe("Slack status activity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("installs renderer configuration with a narrow destination", () => {
    const channel = slackChannel({ activity: { renderers: [slackActivityStatus()] } });
    expect(isCompiledChannel(channel)).toBe(true);
    if (!isCompiledChannel(channel)) return;
    const presentation = getChannelActivityPresentation(channel.adapter);
    expect(presentation?.renderers).toHaveLength(1);
    expect(
      presentation?.destination({ channelId: "C1", secret: "hidden", threadTs: "T1" }),
    ).toEqual({ channelId: "C1", threadTs: "T1" });
  });

  it("rejects duplicate renderer configuration", () => {
    expect(() =>
      slackChannel({ activity: { renderers: [slackActivityStatus(), slackActivityStatus()] } }),
    ).toThrow("Duplicate Slack activity renderer");
  });

  it("prioritizes active actions, then falls back to delegated and root work", () => {
    expect(
      selectSlackActivityStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
          {
            action: {
              id: `${root.id}:search`,
              kind: "tool",
              name: "search",
              parentWorkId: root.id,
              rootTurnId: root.rootTurnId,
              stepIndex: 0,
            },
            eventId: "search",
            kind: "action.started",
            startedAt: "2026-01-01T00:00:01Z",
          },
        ]),
      ),
    ).toBe("search");
    expect(
      selectSlackActivityStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
          {
            eventId: "child",
            kind: "work.started",
            startedAt: "2026-01-01T00:00:01Z",
            work: child,
          },
        ]),
      ),
    ).toBe("research");
    expect(
      selectSlackActivityStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
        ]),
      ),
    ).toBe("Working…");
  });

  it("prioritizes blockers over active actions", () => {
    expect(
      selectSlackActivityStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
          {
            action: {
              id: `${root.id}:search`,
              kind: "tool",
              name: "search",
              parentWorkId: root.id,
              rootTurnId: root.rootTurnId,
              stepIndex: 0,
            },
            eventId: "search",
            kind: "action.started",
            startedAt: "2026-01-01T00:00:01Z",
          },
          {
            blocker: {
              id: "authorization:attempt",
              kind: "authorization",
              parentWorkId: root.id,
              rootTurnId: root.rootTurnId,
            },
            eventId: "authorization",
            kind: "blocker.started",
            startedAt: "2026-01-01T00:00:02Z",
          },
        ]),
      ),
    ).toBe("Waiting for sign-in…");
  });

  it("clears when represented work settles", () => {
    expect(
      selectSlackActivityStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
          {
            eventId: "settled",
            kind: "work.settled",
            outcome: "completed",
            settledAt: "2026-01-01T00:00:01Z",
            workId: root.id,
          },
        ]),
      ),
    ).toBe("");
  });

  it("suppresses duplicate provider writes", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const renderer = buildSlackActivityRenderers({
      botToken: undefined,
      renderers: [slackActivityStatus()],
    })[0]!;
    const active = snapshot([
      { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
    ]);
    const state = await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: active,
      state: undefined,
    });
    await renderer.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: active,
      state,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears transient status on disposal", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const renderer = buildSlackActivityRenderers({
      botToken: undefined,
      renderers: [slackActivityStatus()],
    })[0]!;
    await renderer.dispose?.({
      destination: { channelId: "C1", threadTs: "T1" },
      state: { status: "Working…" },
    });
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get("status")).toBe("");
  });
});
