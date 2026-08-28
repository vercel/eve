import { afterEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { getChannelActivityPresentation } from "#channel/activity-renderer.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import {
  buildSlackActivityRenderers,
  experimental_slackActivityRenderer,
  selectSlackActivityStatus,
  experimental_slackActivityStatus,
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
    const channel = slackChannel({ activity: { renderers: [experimental_slackActivityStatus()] } });
    expect(isCompiledChannel(channel)).toBe(true);
    if (!isCompiledChannel(channel)) return;
    const presentation = getChannelActivityPresentation(channel.adapter);
    expect(presentation?.renderers).toHaveLength(1);
    expect(
      presentation?.destination({ channelId: "C1", secret: "hidden", threadTs: "T1" }),
    ).toEqual({ channelId: "C1", installationTeamId: null, threadTs: "T1" });
  });

  it("installs an experimental custom renderer", async () => {
    const render = vi.fn(async ({ state }: { readonly state: number | undefined }) =>
      state === undefined ? 1 : state + 1,
    );
    const dispose = vi.fn(async () => undefined);
    const custom = experimental_slackActivityRenderer<number>({
      id: "custom.activity.v1",
      render,
      dispose,
    });
    const [renderer] = buildSlackActivityRenderers({ botToken: undefined, renderers: [custom] });
    const activitySnapshot = snapshot([
      { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
    ]);

    await expect(
      renderer?.render({
        destination: { channelId: "C1", installationTeamId: "T1", threadTs: "M1" },
        snapshot: activitySnapshot,
        state: undefined,
      }),
    ).resolves.toBe(1);
    await renderer?.dispose?.({
      destination: { channelId: "C1", installationTeamId: "T1", threadTs: "M1" },
      state: 1,
    });

    expect(render).toHaveBeenCalledWith({
      destination: { channelId: "C1", installationTeamId: "T1", threadTs: "M1" },
      snapshot: activitySnapshot,
      state: undefined,
    });
    expect(dispose).toHaveBeenCalledWith({
      destination: { channelId: "C1", installationTeamId: "T1", threadTs: "M1" },
      state: 1,
    });
  });

  it("rejects invalid experimental custom renderers", () => {
    expect(() =>
      experimental_slackActivityRenderer({ id: "", render: async () => undefined }),
    ).toThrow("ids must be non-empty");
    expect(() =>
      experimental_slackActivityRenderer({
        id: slackActivityStatus().id,
        render: async () => undefined,
      }),
    ).toThrow("reserved by eve");
  });

  it("rejects duplicate renderer configuration", () => {
    expect(() =>
      slackChannel({
        activity: {
          renderers: [experimental_slackActivityStatus(), experimental_slackActivityStatus()],
        },
      }),
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

  it("passes the installation team to function bot tokens", async () => {
    const tokenContext = vi.fn(() => "xoxb-team");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const renderer = buildSlackActivityRenderers({
      botToken: tokenContext,
      renderers: [experimental_slackActivityStatus()],
    })[0]!;

    await renderer.render({
      destination: { channelId: "C1", installationTeamId: "T_INSTALL", threadTs: "T1" },
      snapshot: snapshot([
        { eventId: "root", kind: "work.started", startedAt: "2026-01-01T00:00:00Z", work: root },
      ]),
      state: undefined,
    });

    expect(tokenContext).toHaveBeenCalledWith({ teamId: "T_INSTALL" });
  });

  it("suppresses duplicate provider writes", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const renderer = buildSlackActivityRenderers({
      botToken: undefined,
      renderers: [experimental_slackActivityStatus()],
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
      renderers: [experimental_slackActivityStatus()],
    })[0]!;
    await renderer.dispose?.({
      destination: { channelId: "C1", threadTs: "T1" },
      state: { status: "Working…" },
    });
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get("status")).toBe("");
  });
});
