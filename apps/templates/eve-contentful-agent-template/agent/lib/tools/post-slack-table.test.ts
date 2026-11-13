import type { callSlackApi } from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { slackApi } from "../integrations/slack/api";
import { replyEvents } from "../integrations/slack/replies";
import { visualizationReceipts } from "../integrations/slack/visualizations/receipts";
import { slackAuth, toolContext } from "../testing/session";
import { messageCompletedHarness } from "../testing/slack";
import { testState, installTestState } from "../testing/state";
import { isCallable } from "../values";
import tool from "./post-slack-table";

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn<typeof callSlackApi>(),
}));

const { endsTurn, execute, inputSchema, outputSchema } = tool;
if (
  !isCallable(execute) ||
  !isCallable(endsTurn) ||
  !(inputSchema instanceof z.ZodObject) ||
  !(outputSchema instanceof z.ZodObject)
) {
  throw new Error("Expected an executable table tool with a Zod input schema.");
}
/* Awaits a delivery receipt; these tools return one result rather than streaming progress. */
const receipt = async <T extends object>(
  pending: T | AsyncIterable<T> | PromiseLike<T | AsyncIterable<T>>
): Promise<T> => {
  const result = await pending;
  if (Symbol.asyncIterator in result) {
    throw new Error("Expected a single delivery receipt.");
  }
  return result;
};
/* Fields of a posted Slack message read by these tests; parsing also proves the body shape. */
const postedMessage = z.object({
  blocks: z
    .array(
      z.looseObject({
        page_size: z.number().optional(),
        rows: z.array(z.json()).optional(),
      })
    )
    .optional(),
  text: z.string(),
});
/* Parses the message body sent by one chat.postMessage call. */
const posted = (call = 0) => {
  const request = postMock.mock.calls[call]?.[0];
  if (!request) {
    throw new Error(`Expected Slack call ${call}.`);
  }
  return postedMessage.parse(request.body);
};
const ctx = toolContext({
  current: null,
  initiator: slackAuth({ channelId: "C_TEST", threadTs: "123.456" }),
  toolName: "post_slack_table",
});

const link = {
  text: "Planter guide",
  url: "https://example.com/guide?a=1&b=2",
};
const input = {
  table: {
    columns: ["Title", "Status"],
    rows: [[link, "Published"], ["Plain"]],
  },
  title: "Guides",
};

beforeEach(() => {
  testState.reset();
  vi.stubEnv("SLACK_CONNECTOR", "slack/test");
  postMock.mockResolvedValue({ ok: true });
});

describe("Slack table link cells", () => {
  it("renders mixed cells as labelled links or plain text in the current thread", async () => {
    const result = await execute(input, ctx);
    expect(result).toMatchObject({ posted: true });
    expect(visualizationReceipts.get()).toEqual({
      failed: false,
      posted: true,
      turnId: "turn-1",
    });
    expect(postMock).toHaveBeenCalledExactlyOnceWith({
      body: {
        blocks: [
          {
            caption: "Guides",
            page_size: 2,
            rows: [
              [
                { text: "Title", type: "raw_text" },
                { text: "Status", type: "raw_text" },
              ],
              [
                {
                  elements: [
                    {
                      elements: [{ ...link, type: "link" }],
                      type: "rich_text_section",
                    },
                  ],
                  type: "rich_text",
                },
                { text: "Published", type: "raw_text" },
              ],
              [
                { text: "Plain", type: "raw_text" },
                { text: "-", type: "raw_text" },
              ],
            ],
            type: "data_table",
          },
        ],
        channel: "C_TEST",
        text: expect.stringContaining(`${link.text} (${link.url})`),
        thread_ts: "123.456",
        unfurl_links: false,
      },
      botToken: "test-token",
      operation: "chat.postMessage",
    });
  });

  it("retains labels and destinations when Slack rejects the blocks", async () => {
    postMock.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    expect(await execute(input, ctx)).toMatchObject({
      posted: true,
      usedTextFallback: true,
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(visualizationReceipts.get()).toEqual({
      failed: false,
      posted: true,
      turnId: "turn-1",
    });
    expect(postMock.mock.calls[1][0].body).not.toHaveProperty("blocks");
    const second = posted(1);
    expect(second.text).toBe(posted(0).text);
    expect(second.text).toContain(`${link.text} (${link.url})`);
  });

  it("keeps pages at 10 rows with link cells", async () => {
    await execute(
      {
        ...input,
        table: {
          columns: ["Title"],
          rows: Array.from({ length: 21 }, () => [link]),
        },
      },
      ctx
    );
    const [table] = posted().blocks ?? [];
    expect(table?.page_size).toBe(10);
    expect(table?.rows).toHaveLength(22);
  });

  it.each(["https://example.com/guide", "http://example.com/guide"])(
    "accepts %s",
    (url) => {
      expect(
        inputSchema.safeParse({
          ...input,
          table: { columns: ["Title"], rows: [[{ text: "Guide", url }]] },
        }).success
      ).toBe(true);
    }
  );

  it.each([
    { text: "Guide", url: ["javascript", "alert(1)"].join(":") },
    { text: "Guide", url: "mailto:hello@example.com" },
    { text: "Guide", url: "//example.com" },
    { text: "Guide", url: "[Guide](https://example.com)" },
    { text: "Guide", url: "<https://example.com|Guide>" },
    { text: "Guide", url: `https://example.com/${"x".repeat(2048)}` },
    { text: " ", url: "https://example.com" },
    { text: "x".repeat(501), url: "https://example.com" },
    { text: "Guide" },
    { url: "https://example.com" },
  ])("rejects malformed link cell %j", (cell) => {
    expect(
      inputSchema.safeParse({
        ...input,
        table: { columns: ["Title"], rows: [[cell]] },
      }).success
    ).toBe(false);
  });

  it("ends the turn only after Slack confirms delivery", async () => {
    expect(await endsTurn(await receipt(execute(input, ctx)))).toBe(true);
    postMock.mockResolvedValueOnce({ error: "rate_limited", ok: false });
    expect(await endsTurn(await receipt(execute(input, ctx)))).toBe(false);
  });

  it("rejects links in the header", () => {
    expect(
      inputSchema.safeParse({ ...input, table: { columns: [link], rows: [] } })
        .success
    ).toBe(false);
  });
});

beforeEach(installTestState);

beforeEach(() => {
  vi.spyOn(slackApi, "request").mockImplementation(postMock);
  vi.spyOn(slackApi, "credentials").mockReturnValue({ botToken: "test-token" });
});

describe("bounded table fallback", () => {
  const large = {
    table: {
      columns: ["Title", "Description"],
      rows: Array.from({ length: 100 }, (_, index) => [
        `Entry ${index + 1}`,
        "x".repeat(500),
      ]),
    },
    title: "Large table",
  };

  it("reports complete native delivery separately from shortened alternate text", async () => {
    const result = outputSchema.parse(await execute(large, ctx));
    expect(result).toMatchObject({
      deliveredRows: 100,
      deliveryComplete: true,
      posted: true,
      textShortened: true,
      totalRows: 100,
    });
    const request = posted();
    expect(request.blocks?.[0]?.rows).toHaveLength(101);
    expect(request.text.length).toBeLessThanOrEqual(39_000);
    expect(request.text.split("```")).toHaveLength(3);
  });

  it("discloses exactly the whole rows omitted when text fallback succeeds", async () => {
    postMock.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    const result = outputSchema.parse(await execute(large, ctx));
    expect(result).toMatchObject({
      deliveryComplete: false,
      posted: true,
      textShortened: true,
      totalRows: 100,
      usedTextFallback: true,
    });
    /*
     * Every header, separator, and body line is 511 characters (9-character
     * title column, two-space gutter, 500-character description). The text is
     * the 16-character title prefix, (rows + 2) newline-joined lines, the
     * closing fence, and the notice, totalling 512 * (rows + 2) + 44 for
     * two-digit counts: 38,956 for 74 rows and 39,468 for 75.
     */
    expect(result.deliveredRows).toBe(74);
    const { text } = posted(1);
    expect(text).toContain("Showing 74 of 100 rows.");
    expect(text.length).toBeLessThanOrEqual(39_000);
    expect(text.length + 512).toBeGreaterThan(39_000);
    const body = text.split("```")[1].trimEnd().split("\n").slice(3);
    expect(body).toHaveLength(74);
    expect(body.every((row) => row.endsWith("x".repeat(500)))).toBe(true);
    expect(visualizationReceipts.get()).toMatchObject({
      failed: false,
      posted: true,
    });
    const harness = messageCompletedHarness(replyEvents["message.completed"]);
    await harness.complete();
    expect(harness.next).not.toHaveBeenCalled();
  });

  it("shortens oversized URL cells visibly and neutralizes embedded fences", async () => {
    postMock.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    const result = await execute(
      {
        table: {
          columns: Array.from({ length: 20 }, () => "Column"),
          rows: [
            Array.from({ length: 20 }, () => ({
              text: `\`\`\`\n${"x".repeat(490)}`,
              url: `https://example.com/${"y".repeat(2000)}`,
            })),
          ],
        },
        title: "Oversized row",
      },
      ctx
    );
    const { text } = posted(1);
    expect(result).toMatchObject({
      deliveredRows: 1,
      deliveryComplete: false,
      textShortened: true,
    });
    expect(text).toContain("Shortened text or URLs in 20 cells.");
    expect(text.split("```")).toHaveLength(3);
    expect(text.length).toBeLessThanOrEqual(39_000);
  });

  it("does not report content as delivered when fallback fails", async () => {
    postMock
      .mockResolvedValueOnce({ error: "invalid_blocks", ok: false })
      .mockResolvedValueOnce({ error: "rate_limited", ok: false });
    expect(await execute(large, ctx)).toMatchObject({
      deliveredRows: null,
      deliveryComplete: false,
      posted: false,
    });
    expect(visualizationReceipts.get()).toMatchObject({
      failed: true,
      posted: false,
    });
  });

  it("keeps small table fallback complete", async () => {
    postMock.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    expect(await execute(input, ctx)).toMatchObject({
      deliveredRows: 2,
      deliveryComplete: true,
      textShortened: false,
    });
  });
});

it("fits the exact text budget and omits a whole row one character beyond it", async () => {
  const table = {
    columns: ["Title"],
    rows: Array.from({ length: 200 }, () => ["x".repeat(191)]),
  };
  await execute({ table, title: "Boundary" }, ctx);
  const summary = "s".repeat(39_000 - posted(0).text.length - 2);
  const full = outputSchema.parse(
    await execute({ summary, table, title: "Boundary" }, ctx)
  );
  expect(full.textRowsShown).toBe(200);
  expect(full.textShortened).toBe(false);
  expect(posted(1).text).toHaveLength(39_000);
  const shortened = outputSchema.parse(
    await execute({ summary: `${summary}s`, table, title: "Boundary" }, ctx)
  );
  expect(shortened.textRowsShown).toBe(199);
  expect(shortened.textShortened).toBe(true);
  expect(posted(2).text.length).toBeLessThanOrEqual(39_000);
});
