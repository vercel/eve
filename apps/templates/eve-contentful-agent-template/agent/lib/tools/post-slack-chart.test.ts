import type { callSlackApi } from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { slackApi } from "../integrations/slack/api";
import { visualizationReceipts } from "../integrations/slack/visualizations/receipts";
import type { JsonValue } from "../json";
import { slackAuth, toolContext } from "../testing/session";
import { testState, installTestState } from "../testing/state";
import { isCallable } from "../values";
import tool from "./post-slack-chart";

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn<typeof callSlackApi>(),
}));

const { endsTurn, execute, inputSchema } = tool;
if (
  !isCallable(execute) ||
  !isCallable(endsTurn) ||
  !(inputSchema instanceof z.ZodObject)
) {
  throw new Error("Expected an executable chart tool with a Zod input schema.");
}
type ChartInput = Parameters<typeof execute>[0];
/* Parses through the tool's own schema; the narrowing above erases its output type. */
// SAFETY: The tool’s own Zod schema validates the value; extracting it through eve’s definition erases its output type.
const parse = (value: JsonValue) => inputSchema.parse(value) as ChartInput;
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
  blocks: z.array(z.json()).optional(),
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
  toolName: "post_slack_chart",
});
const input = {
  chart: {
    categories: ["Week 2", "Week 1"],
    series: [
      { name: "Guides", values: [8, 0] },
      { name: "Change", values: [-2, 3.5] },
    ],
    type: "bar" as const,
    xLabel: "Week",
    yLabel: "Entries",
  },
  summary: "Source: https://example.com. Partial period.",
  title: "Guide publications",
};

beforeEach(() => {
  testState.reset();
  vi.stubEnv("SLACK_CONNECTOR", "slack/test");
  postMock.mockResolvedValue({ ok: true });
});

describe("Slack charts", () => {
  it.each(["bar", "line", "area"] as const)(
    "maps %s series to ordered categories and preserves numeric values",
    async (type) => {
      const parsed = parse({
        ...input,
        chart: { ...input.chart, type },
      });
      expect(await execute(parsed, ctx)).toEqual({
        channel: "C_TEST",
        posted: true,
        threadTs: "123.456",
      });
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock.mock.calls[0][0].body).toMatchObject({
        channel: "C_TEST",
        thread_ts: "123.456",
        unfurl_links: false,
      });
      const request = posted();
      expect(request.blocks).toEqual([
        {
          text: { text: input.summary, type: "mrkdwn", verbatim: true },
          type: "section",
        },
        {
          chart: {
            axis_config: {
              categories: ["Week 2", "Week 1"],
              x_label: "Week",
              y_label: "Entries",
            },
            series: [
              {
                data: [
                  { label: "Week 2", value: 8 },
                  { label: "Week 1", value: 0 },
                ],
                name: "Guides",
              },
              {
                data: [
                  { label: "Week 2", value: -2 },
                  { label: "Week 1", value: 3.5 },
                ],
                name: "Change",
              },
            ],
            type,
          },
          title: input.title,
          type: "data_visualization",
        },
      ]);
      expect(request.text).toContain("Week 2: Guides=8; Change=-2");
      expect(request.text).toContain("Week 1: Guides=0; Change=3.5");
      expect(request.text).toContain("Y-axis: Entries");
      expect(visualizationReceipts.get()).toEqual({
        failed: false,
        posted: true,
        turnId: "turn-1",
      });
    }
  );

  it("renders pie weights and omits a null summary", async () => {
    const chart = {
      segments: [
        { label: "Guides", value: 12 },
        { label: "Blogs", value: 3 },
      ],
      type: "pie",
    };
    await execute(parse({ chart, summary: null, title: "Content types" }), ctx);
    const request = posted();
    expect(request.blocks).toEqual([
      { chart, title: "Content types", type: "data_visualization" },
    ]);
    expect(request.text).toBe("Content types\nGuides: 12\nBlogs: 3");
  });

  it("omits null axis labels rather than sending null to Slack", async () => {
    await execute(
      parse({
        ...input,
        chart: { ...input.chart, xLabel: null, yLabel: null },
      }),
      ctx
    );
    expect(posted().blocks?.[1]).toHaveProperty(["chart", "axis_config"], {
      categories: input.chart.categories,
    });
  });

  it("falls back once with all values, units, and caveats after block rejection", async () => {
    postMock.mockResolvedValueOnce({ error: "invalid_blocks", ok: false });
    expect(await execute(parse(input), ctx)).toMatchObject({
      posted: true,
      usedTextFallback: true,
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(postMock.mock.calls[1][0].body).not.toHaveProperty("blocks");
    const second = posted(1);
    expect(second.text).toBe(posted(0).text);
    expect(second.text).toContain(input.summary);
    expect(second.text).toContain("Guides=0; Change=3.5");
  });

  it("escapes Slack control sequences in fallback labels", async () => {
    await execute(parse({ ...input, title: "<@U123> & totals" }), ctx);
    expect(posted().text).toContain("&lt;@U123&gt; &amp; totals");
  });

  it("ends the turn only after Slack confirms delivery", async () => {
    expect(await endsTurn(await receipt(execute(parse(input), ctx)))).toBe(
      true
    );
    postMock.mockResolvedValueOnce({ error: "rate_limited", ok: false });
    expect(await endsTurn(await receipt(execute(parse(input), ctx)))).toBe(
      false
    );
  });

  it("keeps the maximum chart complete in the text fallback", async () => {
    const chart = {
      ...input.chart,
      categories: Array.from({ length: 20 }, (_, i) => `Category ${i}`),
      series: Array.from({ length: 12 }, (_, i) => ({
        name: `Series ${i}`,
        values: Array.from({ length: 20 }, (_value, j) => i * 20 + j),
      })),
    };
    await execute(parse({ ...input, chart }), ctx);
    const { text } = posted();
    expect(text).toContain("Series 11=239");
    expect(text.length).toBeLessThan(39_000);
  });

  /*
   * Each row targets one rule and asserts that rule's issue as the only one.
   * Twenty-one categories necessarily also fail a series rule: 21 values
   * exceed the per-series maximum, while any other length breaks alignment.
   */
  it.each([
    {
      change: { categories: ["Week 1", "Week 1"] },
      issue: { code: "custom", path: ["chart", "categories"] },
    },
    {
      change: { categories: [" Week 1 ", "Week 1"] },
      issue: { code: "custom", path: ["chart", "categories"] },
    },
    {
      change: { categories: ["x".repeat(21), "Week 1"] },
      issue: { code: "too_big", path: ["chart", "categories", 0] },
    },
    {
      change: {
        categories: Array.from({ length: 21 }, (_, i) => String(i)),
        series: [
          { name: "Guides", values: Array.from({ length: 21 }, (_, i) => i) },
        ],
      },
      issue: { code: "too_big", path: ["chart", "categories"] },
      issueCount: 2,
    },
    {
      change: { series: [] },
      issue: { code: "too_small", path: ["chart", "series"] },
    },
    {
      change: { series: [{ name: "Guides", values: [1] }] },
      issue: { code: "custom", path: ["chart", "series", 0, "values"] },
    },
    {
      change: { series: [{ name: "Guides", values: [1, 2, 3] }] },
      issue: { code: "custom", path: ["chart", "series", 0, "values"] },
    },
    {
      change: {
        series: [
          { name: "Guides", values: [1, 2] },
          { name: "Guides", values: [3, 4] },
        ],
      },
      issue: {
        code: "custom",
        message: "Series names must be unique.",
        path: ["chart", "series"],
      },
    },
    {
      change: {
        series: Array.from({ length: 13 }, (_, i) => ({
          name: String(i),
          values: [1, 2],
        })),
      },
      issue: { code: "too_big", path: ["chart", "series"] },
    },
    {
      change: { series: [{ name: "Guides", values: [Number.NaN, 1] }] },
      issue: {
        code: "invalid_type",
        path: ["chart", "series", 0, "values", 0],
      },
    },
    {
      change: {
        series: [{ name: "Guides", values: [Number.POSITIVE_INFINITY, 1] }],
      },
      issue: {
        code: "invalid_type",
        path: ["chart", "series", 0, "values", 0],
      },
    },
    {
      change: { series: [{ name: "Guides", values: [null, 1] }] },
      issue: {
        code: "invalid_type",
        path: ["chart", "series", 0, "values", 0],
      },
    },
    {
      change: { xLabel: "x".repeat(51) },
      issue: { code: "too_big", path: ["chart", "xLabel"] },
    },
    {
      change: { yLabel: undefined },
      issue: { code: "invalid_type", path: ["chart", "yLabel"] },
    },
  ])(
    "rejects invalid cartesian data $change",
    ({ change, issue, issueCount = 1 }) => {
      const result = inputSchema.safeParse({
        ...input,
        chart: { ...input.chart, ...change },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining(issue)
      );
      expect(result.error?.issues).toHaveLength(issueCount);
    }
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid pie weight %s",
    (value) => {
      expect(
        inputSchema.safeParse({
          ...input,
          chart: { segments: [{ label: "Guides", value }], type: "pie" },
        }).success
      ).toBe(false);
    }
  );

  it.each([
    { summary: undefined },
    { title: " " },
    { title: "x".repeat(51) },
    { chart: { segments: [], type: "pie" } },
    {
      chart: {
        segments: Array.from({ length: 13 }, (_, i) => ({
          label: String(i),
          value: 1,
        })),
        type: "pie",
      },
    },
    { chart: { type: "scatter" } },
  ])("rejects missing controls and out-of-bounds charts %j", (change) => {
    expect(inputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});

beforeEach(installTestState);

beforeEach(() => {
  vi.spyOn(slackApi, "request").mockImplementation(postMock);
  vi.spyOn(slackApi, "credentials").mockReturnValue({ botToken: "test-token" });
});
