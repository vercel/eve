import { afterEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { getChannelProgressPresentation } from "#channel/progress-renderer.js";
import { createProgressSnapshot, reduceProgressBatch } from "#execution/session-progress.js";
import {
  buildSlackProgressRenderers,
  selectSlackProgressStatus,
  slackStatusProgress,
} from "#public/channels/slack/progress.js";
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

function snapshot(events: Parameters<typeof reduceProgressBatch>[1]["events"]) {
  return reduceProgressBatch(createProgressSnapshot(), { events, version: 1 });
}

describe("Slack status progress", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("installs renderer configuration with a narrow destination", () => {
    const channel = slackChannel({ progress: { renderers: [slackStatusProgress()] } });
    expect(isCompiledChannel(channel)).toBe(true);
    if (!isCompiledChannel(channel)) return;
    const presentation = getChannelProgressPresentation(channel.adapter);
    expect(presentation?.renderers).toHaveLength(1);
    expect(
      presentation?.destination({ channelId: "C1", secret: "hidden", threadTs: "T1" }),
    ).toEqual({ channelId: "C1", threadTs: "T1" });
  });

  it("rejects duplicate renderer configuration", () => {
    expect(() =>
      slackChannel({ progress: { renderers: [slackStatusProgress(), slackStatusProgress()] } }),
    ).toThrow("Duplicate Slack progress renderer");
  });

  it("prioritizes active actions, then falls back to delegated and root work", () => {
    expect(
      selectSlackProgressStatus(
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
      selectSlackProgressStatus(
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
      selectSlackProgressStatus(
        snapshot([
          { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
        ]),
      ),
    ).toBe("Working…");
  });

  it("prioritizes blockers over active actions", () => {
    expect(
      selectSlackProgressStatus(
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
      selectSlackProgressStatus(
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
    const renderer = buildSlackProgressRenderers({
      botToken: undefined,
      renderers: [slackStatusProgress()],
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
    const renderer = buildSlackProgressRenderers({
      botToken: undefined,
      renderers: [slackStatusProgress()],
    })[0]!;
    await renderer.dispose?.({
      destination: { channelId: "C1", threadTs: "T1" },
      state: { status: "Working…" },
    });
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get("status")).toBe("");
  });
});
