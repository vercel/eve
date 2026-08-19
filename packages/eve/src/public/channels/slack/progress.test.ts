import { afterEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createProgressSnapshot, reduceProgressCommand } from "#execution/session-progress.js";
import {
  buildSlackProgressRenderers,
  selectSlackProgressStatus,
  slackStatusProgress,
} from "#public/channels/slack/progress.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

function snapshot(events: Parameters<typeof reduceProgressCommand>[1]["events"]) {
  return reduceProgressCommand(createProgressSnapshot(), {
    commandId: "command",
    events,
    kind: "progress",
    version: 1,
  });
}

describe("Slack status progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("installs composable renderer configuration with a narrow destination", () => {
    const channel = slackChannel({ progress: { renderers: [slackStatusProgress()] } });
    expect(isCompiledChannel(channel)).toBe(true);
    if (!isCompiledChannel(channel)) return;
    expect(channel.adapter.progressRenderers).toHaveLength(1);
    expect(
      channel.adapter.progressDestination?.({
        channelId: "C1",
        secret: "hidden",
        threadTs: "T1",
      }),
    ).toEqual({ channelId: "C1", threadTs: "T1" });
  });

  it("rejects duplicate renderer configuration", () => {
    expect(() =>
      slackChannel({ progress: { renderers: [slackStatusProgress(), slackStatusProgress()] } }),
    ).toThrow("Duplicate Slack progress renderer");
  });

  it("prioritizes blockers and summarizes parallel work", () => {
    const active = snapshot([
      {
        eventId: "turn",
        kind: "turn",
        turn: {
          id: "turn:root:t1",
          phase: "running",
          sequence: 0,
          startedAt: "2026-08-19T12:00:00.000Z",
        },
      },
      ...["Searching issues", "Running tests"].map((label, index) => ({
        entity: {
          id: `tool:${String(index)}`,
          kind: "tool" as const,
          label,
          phase: "running" as const,
          turnId: "turn:root:t1",
        },
        eventId: `tool:${String(index)}`,
        kind: "entity" as const,
      })),
    ]);
    expect(selectSlackProgressStatus(active)).toBe("Running tests (+1)");
    const reported = reduceProgressCommand(active, {
      commandId: "report",
      events: [
        {
          eventId: "report",
          kind: "report",
          report: {
            id: "report-call",
            message: "Checking integration coverage",
            reportedAt: "2026-08-19T12:00:01.000Z",
          },
          turn: active.turns["turn:root:t1"]!,
        },
      ],
      kind: "progress",
      version: 1,
    });
    expect(selectSlackProgressStatus(reported)).toBe("Checking integration coverage");

    const blocked = reduceProgressCommand(active, {
      commandId: "blocked",
      events: [
        {
          entity: {
            id: "input:1",
            kind: "blocker",
            label: "Approve deployment",
            phase: "blocked",
            turnId: "turn:root:t1",
          },
          eventId: "input",
          kind: "entity",
        },
      ],
      kind: "progress",
      version: 1,
    });
    expect(selectSlackProgressStatus(blocked)).toBe("Approve deployment");
  });

  it("sets, deduplicates, and clears Slack assistant status", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const [renderer] = buildSlackProgressRenderers({
      botToken: "xoxb-test",
      renderers: [slackStatusProgress()],
    });
    const active = snapshot([
      {
        eventId: "start",
        kind: "turn",
        turn: {
          id: "turn:root:t1",
          phase: "running",
          sequence: 0,
          startedAt: "2026-08-19T12:00:00.000Z",
        },
      },
    ]);
    const state = await renderer!.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: active,
      state: undefined,
    });
    await renderer!.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: active,
      state,
    });
    const settled = reduceProgressCommand(active, {
      commandId: "settled",
      events: [
        {
          eventId: "end",
          kind: "turn",
          turn: {
            id: "turn:root:t1",
            phase: "completed",
            sequence: 0,
            settledAt: "2026-08-19T12:00:01.000Z",
            startedAt: "2026-08-19T12:00:00.000Z",
          },
        },
      ],
      kind: "progress",
      version: 1,
    });
    await renderer!.render({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot: settled,
      state,
    });

    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.body)).toContain("status=Working...");
    expect(String(calls[1]?.body)).not.toContain("loading_messages");
  });
});
