import { describe, expect, it, vi } from "vitest";

import type { SlackEvent } from "#public/channels/slack/inbound.js";
import {
  applySuggestedPrompts,
  isSuggestedPromptsTrigger,
  SLACK_MAX_SUGGESTED_PROMPTS,
} from "#public/channels/slack/suggested-prompts.js";

function buildEvent(type: string, inner: Record<string, unknown>): SlackEvent {
  return {
    type,
    event: { type, ...inner },
    teamId: "T01",
    eventId: "Ev1",
    eventTime: 1700000000,
    channelId: undefined,
    threadTs: undefined,
  };
}

function buildThreadStartedEvent(): SlackEvent {
  return buildEvent("assistant_thread_started", {
    assistant_thread: {
      user_id: "U01",
      channel_id: "D01",
      thread_ts: "1700000000.000001",
      context: { channel_id: null, team_id: "T01", enterprise_id: null },
    },
  });
}

function buildAppHomeOpenedEvent(tab: string): SlackEvent {
  return buildEvent("app_home_opened", { user: "U01", channel: "D01", tab });
}

const PROMPTS = [{ title: "Catch me up", message: "What did I miss today?" }];

describe("isSuggestedPromptsTrigger", () => {
  it("matches assistant_thread_started (legacy assistant_view)", () => {
    expect(isSuggestedPromptsTrigger(buildThreadStartedEvent())).toBe(true);
  });

  it("matches app_home_opened on the Messages tab (agent_view)", () => {
    expect(isSuggestedPromptsTrigger(buildAppHomeOpenedEvent("messages"))).toBe(true);
  });

  it("ignores app_home_opened on the Home tab", () => {
    expect(isSuggestedPromptsTrigger(buildAppHomeOpenedEvent("home"))).toBe(false);
  });

  it("ignores unrelated events", () => {
    expect(isSuggestedPromptsTrigger(buildEvent("reaction_added", {}))).toBe(false);
  });
});

describe("applySuggestedPrompts", () => {
  it("targets the assistant thread for assistant_thread_started", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    await applySuggestedPrompts({
      suggestedPrompts: { title: "Welcome!", prompts: PROMPTS },
      event: buildThreadStartedEvent(),
      request,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("assistant.threads.setSuggestedPrompts", {
      channel_id: "D01",
      thread_ts: "1700000000.000001",
      title: "Welcome!",
      prompts: [{ title: "Catch me up", message: "What did I miss today?" }],
    });
  });

  it("omits thread_ts for the agent_view Messages tab trigger", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    await applySuggestedPrompts({
      suggestedPrompts: { prompts: PROMPTS },
      event: buildAppHomeOpenedEvent("messages"),
      request,
    });

    expect(request).toHaveBeenCalledTimes(1);
    const body = request.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.channel_id).toBe("D01");
    expect(body).not.toHaveProperty("thread_ts");
    expect(body).not.toHaveProperty("title");
  });

  it("drops prompts beyond Slack's cap", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const prompts = Array.from({ length: 6 }, (_, index) => ({
      title: `Prompt ${index}`,
      message: `message ${index}`,
    }));

    await applySuggestedPrompts({
      suggestedPrompts: { prompts },
      event: buildAppHomeOpenedEvent("messages"),
      request,
    });

    const body = request.mock.calls[0]![1] as { prompts: unknown[] };
    expect(body.prompts).toHaveLength(SLACK_MAX_SUGGESTED_PROMPTS);
  });

  it("invokes a resolver with the conversation context", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const resolver = vi.fn().mockResolvedValue({ prompts: PROMPTS });

    await applySuggestedPrompts({
      suggestedPrompts: resolver,
      event: buildThreadStartedEvent(),
      request,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toMatchObject({
      channelId: "D01",
      threadTs: "1700000000.000001",
      userId: "U01",
      teamId: "T01",
      event: { type: "assistant_thread_started" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("skips the API call when the resolver returns null", async () => {
    const request = vi.fn();

    await applySuggestedPrompts({
      suggestedPrompts: () => null,
      event: buildThreadStartedEvent(),
      request,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("skips the API call when prompts are empty", async () => {
    const request = vi.fn();

    await applySuggestedPrompts({
      suggestedPrompts: { prompts: [] },
      event: buildThreadStartedEvent(),
      request,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("does nothing for a non-Messages app_home_opened tab", async () => {
    const request = vi.fn();

    await applySuggestedPrompts({
      suggestedPrompts: { prompts: PROMPTS },
      event: buildAppHomeOpenedEvent("home"),
      request,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("swallows a throwing resolver", async () => {
    const request = vi.fn();

    await expect(
      applySuggestedPrompts({
        suggestedPrompts: () => {
          throw new Error("bad resolver");
        },
        event: buildThreadStartedEvent(),
        request,
      }),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("swallows a rejecting API call", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network"));

    await expect(
      applySuggestedPrompts({
        suggestedPrompts: { prompts: PROMPTS },
        event: buildThreadStartedEvent(),
        request,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when assistant_thread_started carries no assistant_thread", async () => {
    const request = vi.fn();

    await applySuggestedPrompts({
      suggestedPrompts: { prompts: PROMPTS },
      event: buildEvent("assistant_thread_started", {}),
      request,
    });

    expect(request).not.toHaveBeenCalled();
  });
});
