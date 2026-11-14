import type { connectSlackCredentials } from "@vercel/connect/eve";
import type { callSlackApi } from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { slackApi } from "../api";
import {
  visualizationDelivery,
  postVisualization,
  visualizationOutputSchema,
} from "./post";
import type { recordVisualizationDelivery } from "./receipts";

const { credentials, post, record } = vi.hoisted(() => ({
  credentials: vi.fn<typeof connectSlackCredentials>(),
  post: vi.fn<typeof callSlackApi>(),
  record: vi.fn<typeof recordVisualizationDelivery>(),
}));

const ctx = {
  session: {
    auth: {
      current: {
        attributes: { channel_id: "C_CURRENT", thread_ts: "999.000" },
      },
      initiator: {
        attributes: { channel_id: "C_ORIGIN", thread_ts: "123.456" },
      },
    },
    turn: { id: "turn-1" },
  },
} satisfies Parameters<typeof postVisualization>[0];
const message = {
  blocks: [
    { text: { text: "Rendered data", type: "plain_text" }, type: "section" },
  ],
  text: "Complete data and sources.",
};

beforeEach(() => {
  vi.stubEnv("SLACK_CONNECTOR", "slack/test");
  credentials.mockReturnValue({ botToken: "test-token" });
  post.mockResolvedValue({ ok: true });
});

describe("visualization posting", () => {
  it("posts once to the session origin and returns only a delivery receipt", async () => {
    const result = await postVisualization(ctx, message);
    expect(credentials).toHaveBeenCalledExactlyOnceWith("slack/test");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      body: {
        ...message,
        channel: "C_ORIGIN",
        thread_ts: "123.456",
        unfurl_links: false,
      },
      botToken: "test-token",
      operation: "chat.postMessage",
    });
    expect(result).toEqual({
      channel: "C_ORIGIN",
      posted: true,
      threadTs: "123.456",
    });
    expect(visualizationOutputSchema.safeParse(result).success).toBe(true);
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
  });

  it("uses current auth when the session has no original Slack thread", async () => {
    const result = await postVisualization(
      {
        session: {
          ...ctx.session,
          auth: { ...ctx.session.auth, initiator: null },
        },
      },
      message
    );
    expect(result).toEqual({
      channel: "C_CURRENT",
      posted: true,
      threadTs: "999.000",
    });
    expect(post.mock.calls[0][0].body).toMatchObject({
      channel: "C_CURRENT",
      thread_ts: "999.000",
    });
  });

  it("records missing thread context without loading credentials or calling Slack", async () => {
    const result = await postVisualization(
      {
        session: { ...ctx.session, auth: { current: null, initiator: null } },
      },
      message
    );
    expect(result).toEqual({
      error: "The current session has no Slack thread to post to.",
      posted: false,
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });

  it("records fallback success only after the text-only post resolves", async () => {
    post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    post.mockImplementationOnce(() => {
      expect(record).not.toHaveBeenCalled();
      return Promise.resolve({ ok: true });
    });
    const result = await postVisualization(ctx, message);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, {
      body: {
        channel: "C_ORIGIN",
        text: message.text,
        thread_ts: "123.456",
        unfurl_links: false,
      },
      botToken: "test-token",
      operation: "chat.postMessage",
    });
    expect(result).toEqual({
      channel: "C_ORIGIN",
      posted: true,
      threadTs: "123.456",
      usedTextFallback: true,
    });
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
  });

  it.each(["channel_not_found", "missing_scope", "ratelimited", undefined])(
    "does not retry a non-block rejection: %s",
    async (errorCode) => {
      post.mockResolvedValueOnce({ error: errorCode, ok: false });
      expect(await postVisualization(ctx, message)).toEqual({
        error: errorCode ?? "unknown_error",
        posted: false,
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    }
  );

  it.each(["invalid_blocks", "message_too_long", undefined])(
    "does not retry a rejected fallback: %s",
    async (errorCode) => {
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: errorCode, ok: false });
      expect(await postVisualization(ctx, message)).toEqual({
        error: errorCode ?? "unknown_error",
        posted: false,
      });
      expect(post).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    }
  );

  it.each([
    {
      expected: "connection closed",
      rejection: new Error("connection closed"),
    },
    { expected: "Slack post failed", rejection: "transport failed" },
  ])(
    "does not retry uncertain delivery: $expected",
    async ({ rejection, expected }) => {
      post.mockRejectedValueOnce(rejection);
      expect(await postVisualization(ctx, message)).toEqual({
        error: expected,
        posted: false,
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    }
  );

  it("does not retry when fallback delivery is uncertain", async () => {
    post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    post.mockRejectedValueOnce(new Error("fallback timed out"));
    expect(await postVisualization(ctx, message)).toEqual({
      error: "fallback timed out",
      posted: false,
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });

  it("records credential failures without a Slack request", async () => {
    credentials.mockImplementationOnce(() => {
      throw new Error("credentials unavailable");
    });
    expect(await postVisualization(ctx, message)).toEqual({
      error: "credentials unavailable",
      posted: false,
    });
    expect(post).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });

  it("records missing connector configuration without requesting credentials", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "");
    expect(await postVisualization(ctx, message)).toMatchObject({
      error: expect.stringContaining("SLACK_CONNECTOR"),
      posted: false,
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });
});

beforeEach(() => {
  vi.spyOn(slackApi, "request").mockImplementation(post);
  vi.spyOn(slackApi, "credentials").mockImplementation(credentials);
  vi.spyOn(visualizationDelivery, "record").mockImplementation(record);
});
