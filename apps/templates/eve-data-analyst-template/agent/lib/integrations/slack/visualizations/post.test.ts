import type { connectSlackCredentials } from "@vercel/connect/eve";
import type { callSlackApi } from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { recordQuery } from "../../../analyst/query-log";
import { installTestState, testState } from "../../../testing/state";
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

const sqlQuery = () =>
  recordQuery("turn-1", {
    purpose: "Signups by source",
    ranAt: "2026-10-10T09:14:00.000Z",
    sql: "SELECT source, count(*) FROM signups WHERE n >= 1 GROUP BY 1",
    tables: ["analytics.signups"],
  });
const bodyOf = (call: number) =>
  z
    .object({ blocks: z.array(z.json()).optional(), text: z.string() })
    .parse(post.mock.calls[call]?.[0].body);

const blocksOf = (call: number) => JSON.stringify(bodyOf(call).blocks);

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("SLACK_CONNECTOR", "slack/test");
  credentials.mockReturnValue({ botToken: "test-token" });
  post.mockResolvedValue({ ok: true });
});

describe("visualization posting", () => {
  it("adds the turn's SQL below the visualization and to the text fallback", async () => {
    recordQuery("turn-1", {
      purpose: "Signups by source",
      ranAt: "2026-10-10T09:14:00.000Z",
      sql: "SELECT source, count(*) FROM signups GROUP BY 1",
      tables: ["analytics.signups"],
    });
    await postVisualization(ctx, message);
    const body = z
      .object({ blocks: z.array(z.json()), text: z.string() })
      .parse(post.mock.calls[0]?.[0].body);
    expect(JSON.stringify(body.blocks)).toContain('"type":"container"');
    expect(JSON.stringify(body.blocks)).toContain(
      "SELECT source, count(*) FROM signups GROUP BY 1"
    );
    expect(body.text).toContain("Complete data and sources.");
    expect(body.text).toContain("*SQL query*");
    expect(body.text).toContain("```\nSELECT source");
  });

  it("ignores queries recorded for another turn", async () => {
    recordQuery("turn-0", {
      purpose: "Earlier",
      ranAt: "2026-10-10T09:14:00.000Z",
      sql: "SELECT 1",
      tables: [],
    });
    await postVisualization(ctx, message);
    expect(post.mock.calls[0]?.[0].body).toMatchObject(message);
    expect(JSON.stringify(post.mock.calls[0]?.[0].body)).not.toContain(
      "container"
    );
  });

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
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: errorCode ?? "unknown_error",
        posted: false,
      });
      expect(post).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    }
  );

  it.each(["invalid_blocks", "message_too_long", undefined])(
    "does not retry a rejected fallback: %s",
    async (errorCode) => {
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: errorCode, ok: false });
      await expect(postVisualization(ctx, message)).resolves.toEqual({
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
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: expected,
        posted: false,
      });
      expect(post).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    }
  );

  it("does not retry when fallback delivery is uncertain", async () => {
    post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    post.mockRejectedValueOnce(new Error("fallback timed out"));
    await expect(postVisualization(ctx, message)).resolves.toEqual({
      error: "fallback timed out",
      posted: false,
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });

  describe("with an attached SQL section", () => {
    const delivered = {
      channel: "C_ORIGIN",
      posted: true,
      threadTs: "123.456",
    };

    it("retries with the SQL as plain blocks when Slack refuses the container", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      await expect(postVisualization(ctx, message)).resolves.toEqual(delivered);
      expect(post).toHaveBeenCalledTimes(2);
      expect(blocksOf(0)).toContain('"type":"container"');
      expect(blocksOf(1)).not.toContain("container");
      expect(bodyOf(1).blocks?.slice(0, 1)).toEqual(message.blocks);
      expect(blocksOf(1)).toContain('"type":"rich_text_preformatted"');
      expect(blocksOf(1)).toContain("WHERE n >= 1");
      expect(blocksOf(1)).toContain("*SQL query*");
      expect(bodyOf(1).text).toBe(bodyOf(0).text);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
    });

    it.each(["msg_blocks_too_long", "msg_blocks_too_many"])(
      "posts the SQL as its own message after a size error: %s",
      async (errorCode) => {
        sqlQuery();
        post.mockResolvedValueOnce({ error: errorCode, ok: false });
        await expect(postVisualization(ctx, message)).resolves.toEqual(
          delivered
        );
        expect(post).toHaveBeenCalledTimes(3);
        expect(bodyOf(1).blocks).toEqual(message.blocks);
        expect(bodyOf(2).blocks).toBeUndefined();
        expect(bodyOf(2).text).toMatch(/^\*SQL query\*/u);
        expect(bodyOf(2).text).toContain("WHERE n &gt;= 1");
        expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
      }
    );

    it("posts the SQL as its own message when Slack refuses both SQL forms", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      await expect(postVisualization(ctx, message)).resolves.toEqual(delivered);
      expect(post).toHaveBeenCalledTimes(4);
      expect(bodyOf(2).blocks).toEqual(message.blocks);
      expect(post.mock.calls[3]?.[0].body).toEqual({
        channel: "C_ORIGIN",
        text: expect.stringMatching(/^\*SQL query\*/u),
        thread_ts: "123.456",
        unfurl_links: false,
      });
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
    });

    it("keeps the SQL in the text fallback when every block post is refused", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        ...delivered,
        usedTextFallback: true,
      });
      expect(post).toHaveBeenCalledTimes(4);
      expect(bodyOf(3).blocks).toBeUndefined();
      expect(bodyOf(3).text).toContain("Complete data and sources.");
      expect(bodyOf(3).text).toContain("WHERE n &gt;= 1");
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
    });

    it("posts the SQL separately when it doesn't fit in the text fallback", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      const long = { ...message, text: "x".repeat(38_990) };
      await expect(postVisualization(ctx, long)).resolves.toEqual({
        ...delivered,
        usedTextFallback: true,
      });
      expect(post).toHaveBeenCalledTimes(5);
      expect(bodyOf(3).text).toBe(long.text);
      expect(bodyOf(4).text).toContain("WHERE n &gt;= 1");
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
    });

    it("reports delivery when only the separate SQL message fails", async () => {
      sqlQuery();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => null);
      post.mockResolvedValueOnce({ error: "msg_blocks_too_long", ok: false });
      post.mockResolvedValueOnce({ ok: true });
      post.mockRejectedValueOnce(new Error("socket hang up"));
      await expect(postVisualization(ctx, message)).resolves.toEqual(delivered);
      expect(post).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", true);
    });

    it("stops after a non-block rejection of a retry", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockResolvedValueOnce({ error: "ratelimited", ok: false });
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: "ratelimited",
        posted: false,
      });
      expect(post).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    });

    it("does not retry when the retry's delivery is uncertain", async () => {
      sqlQuery();
      post.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
      post.mockRejectedValueOnce(new Error("retry timed out"));
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: "retry timed out",
        posted: false,
      });
      expect(post).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    });

    it("keeps the thrown message when Slack's reply has no error code", async () => {
      sqlQuery();
      post.mockRejectedValueOnce(
        Object.assign(new Error("Slack chat.postMessage returned HTTP 500"), {
          response: { ok: false },
        })
      );
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: "Slack chat.postMessage returned HTTP 500",
        posted: false,
      });
      expect(post).toHaveBeenCalledOnce();
    });

    it("does not retry when the first post throws, and keeps Slack's error code", async () => {
      sqlQuery();
      post.mockRejectedValueOnce(
        Object.assign(new Error("Slack chat.postMessage returned HTTP 429"), {
          response: { error: "ratelimited", ok: false },
        })
      );
      await expect(postVisualization(ctx, message)).resolves.toEqual({
        error: "Slack chat.postMessage returned HTTP 429 (ratelimited)",
        posted: false,
      });
      expect(post).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
    });
  });

  it("records credential failures without a Slack request", async () => {
    credentials.mockImplementationOnce(() => {
      throw new Error("credentials unavailable");
    });
    await expect(postVisualization(ctx, message)).resolves.toEqual({
      error: "credentials unavailable",
      posted: false,
    });
    expect(post).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith("turn-1", false);
  });

  it("records missing connector configuration without requesting credentials", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "");
    await expect(postVisualization(ctx, message)).resolves.toMatchObject({
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
