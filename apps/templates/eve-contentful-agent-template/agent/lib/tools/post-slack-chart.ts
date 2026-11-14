import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  postVisualization,
  visualizationOutputSchema,
} from "../integrations/slack/visualizations/post";

/* Trimmed, nonempty Slack category, series, or pie label, limited to 20 characters. */
const labelSchema = z.string().trim().min(1).max(20);

/* Optional axis title; null omits the Slack field rather than sending a null value. */
const axisLabelSchema = z.string().trim().min(1).max(50).nullable();

/* One named series of finite values, aligned by index with the chart's categories. */
const seriesSchema = z.strictObject({
  name: labelSchema.describe("Unique series name, at most 20 characters."),
  values: z
    .array(z.number())
    .min(1)
    .max(20)
    .describe(
      "One finite number per category, in the same order. Negative values are allowed. Do not substitute zero for missing data."
    ),
});
/**
 * Bar, line, or area input with up to 12 series and 20 categories.
 *
 * @remarks Requires unique categories and series names after trimming, and one
 * value per category in every series. Invalid lengths are rejected rather than
 * padded or truncated. Zero and negative values are valid; missing values are not.
 * Category and series order are preserved, including Slack's area layering order.
 */
const cartesianSchema = z
  .strictObject({
    categories: z
      .array(labelSchema)
      .min(1)
      .max(20)
      .describe(
        "Unique category labels in display order, at most 20 characters each. Order time periods chronologically."
      ),
    series: z.array(seriesSchema).min(1).max(12),
    type: z.enum(["bar", "line", "area"]),
    xLabel: axisLabelSchema.describe(
      "X-axis title including units where relevant. Null omits it."
    ),
    yLabel: axisLabelSchema.describe(
      "Y-axis title including units where relevant. Null omits it."
    ),
  })
  .superRefine((chart, ctx) => {
    if (new Set(chart.categories).size !== chart.categories.length) {
      ctx.addIssue({
        code: "custom",
        message: "Category labels must be unique.",
        path: ["categories"],
      });
    }
    if (
      new Set(chart.series.map(({ name }) => name)).size !== chart.series.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Series names must be unique.",
        path: ["series"],
      });
    }
    for (const [index, series] of chart.series.entries()) {
      if (series.values.length !== chart.categories.length) {
        ctx.addIssue({
          code: "custom",
          message: "Each series must have exactly one value per category.",
          path: ["series", index, "values"],
        });
      }
    }
  });
/**
 * One to 12 labelled pie segments with finite, strictly positive weights.
 *
 * @remarks Slack derives percentages from the supplied weights. The renderer
 * preserves weights and segment order without calculating rounded percentages.
 */
const pieSchema = z.strictObject({
  segments: z
    .array(
      z.strictObject({
        label: labelSchema,
        value: z
          .number()
          .positive()
          .describe(
            "Positive weight for this slice; Slack computes percentages from all weights."
          ),
      })
    )
    .min(1)
    .max(12),
  type: z.literal("pie"),
});
/* Chart kind selects the applicable series or segment validation contract. */
const chartSchema = z.discriminatedUnion("type", [cartesianSchema, pieSchema]);

/* Validated chart data consumed by both native-block and text rendering. */
type Chart = z.infer<typeof chartSchema>;

/**
 * Build one Slack data_visualization block from validated chart data.
 *
 * @param title - Validated visible chart title, at most 50 characters.
 * @param chart - Parsed chart with aligned categories and series, or positive pie weights.
 * @returns A native chart block ready for chat.postMessage's blocks array.
 * @remarks Assumes {@link postSlackChartInputSchema} has validated the input.
 * Maps series values to category labels by index, omits null axis titles, and
 * preserves every value and the caller's ordering. Does not post to Slack.
 */
const chartBlock = (title: string, chart: Chart) => ({
  chart:
    chart.type === "pie"
      ? chart
      : {
          axis_config: {
            categories: chart.categories,
            ...(chart.xLabel !== null && { x_label: chart.xLabel }),
            ...(chart.yLabel !== null && { y_label: chart.yLabel }),
          },
          series: chart.series.map(({ name, values }) => ({
            data: chart.categories.map((label, index) => ({
              label,
              value: values[index],
            })),
            name,
          })),
          type: chart.type,
        },
  title,
  type: "data_visualization" as const,
});

/**
 * Escape Slack control characters in the accessible text alternative.
 *
 * @param value - Unescaped label, summary, or assembled data line.
 * @returns Text with ampersands and angle brackets encoded for Slack.
 * @remarks Prevents control sequences such as explicit mentions in fallback text;
 * this is not a general Markdown sanitizer.
 */
const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Render the complete chart as a readable text alternative.
 *
 * @param title - Validated chart title.
 * @param summary - Brief takeaway or necessary clarification; null omits the introduction.
 * @param chart - Validated chart whose labels and values must all be retained.
 * @returns Escaped, newline-separated text for accessibility and block-rejection fallback.
 * @remarks Includes supplied axis titles and units, preserves all numeric values,
 * and represents pie slices by their original weights. No rows are truncated;
 * input bounds keep the text within Slack's message limit.
 */
const chartText = (
  title: string,
  summary: string | null,
  chart: Chart
): string => {
  const lines =
    chart.type === "pie"
      ? chart.segments.map(({ label, value }) => `${label}: ${value}`)
      : [
          ...(chart.xLabel ? [`X-axis: ${chart.xLabel}`] : []),
          ...(chart.yLabel ? [`Y-axis: ${chart.yLabel}`] : []),
          ...chart.categories.map(
            (label, index) =>
              `${label}: ${chart.series.map(({ name, values }) => `${name}=${values[index]}`).join("; ")}`
          ),
        ];
  return [summary, title, ...lines]
    .filter((line): line is string => Boolean(line))
    .map(escapeText)
    .join("\n");
};

/**
 * Input contract for posting one chart with a title and nullable summary.
 *
 * @remarks All controls are required; null omits the summary or axis titles.
 * Titles are limited to 50 characters and summaries to 1,000. Nested schemas
 * enforce finite values, Slack size limits, and category/series alignment.
 * Validation neither retrieves data nor verifies its source or completeness.
 *
 * @see {@link https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/ | Slack data visualization block}
 */
const postSlackChartInputSchema = z.strictObject({
  chart: chartSchema.describe(
    "One chart. Maximum 12 series and 20 categories, or 12 pie segments. Every series must have one value per category. Shorten labels without making them ambiguous; do not silently omit data to fit limits."
  ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .nullable()
    .describe(
      "Optional brief takeaway or clarification, usually one sentence. Explain methodology only when requested or when a limitation materially affects interpretation. Null omits it. Put any needed commentary here."
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .describe(
      "Visible chart title, at most 50 characters. Make the measure and relevant time window clear, such as published versus updated content."
    ),
});

/**
 * Posts one native Slack chart using data already retrieved or supplied by the user.
 *
 * @remarks Eve validates input before execution. Uses thread coordinates from
 * session auth, never model-supplied destinations. Posts a native block and its
 * text alternative through {@link postVisualization}; an explicit block rejection
 * gets one text-only fallback, while uncertain delivery is not retried.
 * Successful delivery ends the turn without calling the model again. When the
 * model's step also calls other tools, the turn continues and successful delivery
 * suppresses duplicate final replies only when the same turn has no failed
 * visualization attempts. Shared receipts retain these outcomes
 * across explicit session-limit continuations. Results contain delivery metadata,
 * not a copy of the chart data. No sandbox or image generation is involved.
 */
export default defineTool({
  description:
    "Post a bar, line, area, or pie chart in the current Slack thread to show comparisons, trends, or proportions. Use retrieved or user-supplied data. Keep accompanying text brief and let the chart carry the answer; put any needed commentary in summary. Bar compares categories; line shows trends; area series overlap rather than stack; pie shows positive parts of a whole. Use a table when individual records or links matter. If posting fails, explain the failure.",
  endsTurn: (output) => output.posted,
  /**
   * Render and deliver the validated chart to the current Slack thread.
   *
   * @param input - Parsed chart, title, and nullable summary.
   * @param ctx - Eve context supplying the authenticated thread and receipt scope.
   * @returns Delivery receipt indicating success, failure, or text-fallback use.
   */
  execute(input, ctx) {
    const { chart, summary, title } = input;
    return postVisualization(ctx, {
      blocks: [
        ...(summary
          ? [
              {
                text: { text: summary, type: "mrkdwn", verbatim: true },
                type: "section",
              },
            ]
          : []),
        chartBlock(title, chart),
      ],
      text: chartText(title, summary, chart),
    });
  },
  inputSchema: postSlackChartInputSchema,
  outputSchema: visualizationOutputSchema,
});
