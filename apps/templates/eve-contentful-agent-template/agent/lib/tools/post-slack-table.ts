import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  postVisualization,
  visualizationOutputSchema,
} from "../integrations/slack/visualizations/post";
import { isString } from "../values";

/**
 * Slack chat.postMessage text hard limit, with headroom left for the code fence and title
 * in the plain-text fallback.
 */
const MAX_MESSAGE_CHARS = 39_000;

/**
 * Column gutter used between cells in the plain-text fallback tables.
 */
const GUTTER = "  ";

/**
 * Number of body rows shown per page in Slack data tables.
 */
const PAGE_SIZE = 10;

const cellSchema = z.union([
  z.string().max(500),
  z.object({
    text: z.string().trim().min(1).max(500),
    url: z.url({ protocol: /^https?$/u }).max(2048),
  }),
]);

/**
 * One table: plain-text headers and body cells containing text or labelled links.
 *
 * @remarks
 * Cells are addressed by column index; a short row is padded with blanks and any extra cells
 * beyond the column count are dropped, so a ragged row can never misalign the table. Bounds
 * (20 columns, 200 rows) stay within the Slack data_table block limits.
 */
const tableSchema = z.object({
  columns: z.array(z.string().max(200)).min(1).max(20),
  rows: z.array(z.array(cellSchema).max(20)).max(200),
});

type Table = z.infer<typeof tableSchema>;
type Cell = z.infer<typeof cellSchema>;

/**
 * Normalize a row to exactly `width` cells, so every row matches the header column count as the
 * data_table block requires.
 *
 * @param row - The caller's row cells.
 * @param width - The table's column count.
 * @returns Exactly `width` cells.
 */
const fitRow = (row: readonly Cell[], width: number): Cell[] =>
  Array.from({ length: width }, (_, column) => row[column] ?? "");

/**
 * A Slack data_table `raw_text` cell. Empty text is rejected by Slack, so blanks become a dash.
 *
 * @param value - The cell's string value.
 * @returns A `raw_text` cell object.
 */
const rawTextCell = (value: string) => ({
  text: value.trim() === "" ? "-" : value,
  type: "raw_text" as const,
});

const bodyCell = (value: Cell) =>
  isString(value)
    ? rawTextCell(value)
    : {
        elements: [
          {
            elements: [
              { text: value.text, type: "link" as const, url: value.url },
            ],
            type: "rich_text_section" as const,
          },
        ],
        type: "rich_text" as const,
      };

const cellText = (value: Cell): string =>
  isString(value) ? value : `${value.text} (${value.url})`;

/**
 * Build a Slack data_table block from a table, with the columns as the header row.
 *
 * @param caption - Accessible caption and visible label for the table.
 * @param table - The validated table.
 * @returns A data_table block ready for `chat.postMessage` `blocks`.
 */
const dataTableBlock = (caption: string, table: Table) => {
  const width = table.columns.length;
  const body =
    table.rows.length > 0
      ? table.rows.map((row) => fitRow(row, width).map(bodyCell))
      : [
          Array.from({ length: width }, (_, column) =>
            rawTextCell(column === 0 ? "No data" : "")
          ),
        ];
  return {
    caption,
    page_size: Math.min(PAGE_SIZE, Math.max(1, body.length)),
    rows: [table.columns.map(rawTextCell), ...body],
    type: "data_table" as const,
  };
};

const safe = (text: string) =>
  text.replaceAll("`", "ˋ").replaceAll("\n", "\\n").replaceAll("\r", "\\r");

/**
 * Build bounded fallback text without splitting rows or leaving a fence open.
 *
 * @param summary - Optional lead-in shown before the table.
 * @param title - Visible table title.
 * @param table - Validated rows and headers.
 * @returns Text plus completeness metadata, independent of Slack delivery success.
 * @remarks Oversized link cells are shortened visibly. Row omissions and cell shortening
 * are disclosed inside the message because successful delivery suppresses further prose.
 */
const fallbackText = (
  summary: string | undefined,
  title: string,
  table: Table
) => {
  let shortenedCells = 0;
  const rows = table.rows.map((row) => {
    let shortened = 0;
    const cells = fitRow(row, table.columns.length).map((cell) => {
      const text = safe(cellText(cell));
      if (text.length <= 500) {
        return text;
      }
      shortened += 1;
      return `${text.slice(0, 499)}…`;
    });
    return { cells, shortened };
  });
  const headings = table.columns.map(safe);
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row.cells[column].length))
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join(GUTTER);
  const prefix = [summary && safe(summary), `${safe(title)}\n\`\`\`\n`]
    .filter(Boolean)
    .join("\n\n");
  const lines = table.rows.length
    ? [line(headings), widths.map((width) => "-".repeat(width)).join(GUTTER)]
    : ["No data."];
  const notice = (shown: number, clipped: number) =>
    [
      ...(shown < table.rows.length
        ? [`Showing ${shown} of ${table.rows.length} rows.`]
        : []),
      ...(clipped > 0 ? [`Shortened text or URLs in ${clipped} cells.`] : []),
    ].join(" ");
  const assemble = (body: string[], shown: number, clipped: number) =>
    [`${prefix}${body.join("\n")}\n\`\`\``, notice(shown, clipped)]
      .filter(Boolean)
      .join("\n\n");
  let rowsShown = 0;
  for (const row of rows) {
    const next = [...lines, line(row.cells)];
    if (
      assemble(next, rowsShown + 1, shortenedCells + row.shortened).length >
      MAX_MESSAGE_CHARS
    ) {
      break;
    }
    lines.push(line(row.cells));
    shortenedCells += row.shortened;
    rowsShown += 1;
  }
  return {
    rowsShown,
    shortened: rowsShown < table.rows.length || shortenedCells > 0,
    text: assemble(lines, rowsShown, shortenedCells),
  };
};

/**
 * Tool that posts a table to the current Slack thread.
 *
 * @remarks
 * Uses the thread coordinates from session auth, never model-supplied channel values. Renders the
 * table as a Slack `data_table` block, retrying once as fixed-width text if Slack rejects blocks.
 * Successful delivery ends the turn without calling the model again, so no final reply follows.
 */
export default defineTool({
  description:
    "Post a table in the current Slack thread when tabular presentation helps. For content lists, use labelled title links with known URLs rather than a separate URL column. Keep accompanying text brief and let the table carry the answer; put any needed commentary in summary. If posting fails, explain the failure.",
  endsTurn: (output) => output.posted,
  async execute({ summary, table, title }, ctx) {
    const fallback = fallbackText(summary, title, table);
    const tableBlock = dataTableBlock(title, table);
    const blocks = [
      ...(summary
        ? [
            {
              text: { text: summary, type: "mrkdwn" as const },
              type: "section" as const,
            },
          ]
        : []),
      tableBlock,
    ];

    const delivery = await postVisualization(ctx, {
      blocks,
      text: fallback.text,
    });
    const successfulRows = delivery.usedTextFallback
      ? fallback.rowsShown
      : table.rows.length;
    return {
      ...delivery,
      deliveredRows: delivery.posted ? successfulRows : null,
      deliveryComplete:
        delivery.posted && !(delivery.usedTextFallback && fallback.shortened),
      textRowsShown: fallback.rowsShown,
      textShortened: fallback.shortened,
      totalRows: table.rows.length,
    };
  },
  inputSchema: z.object({
    summary: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "Optional brief takeaway or clarification, usually one sentence. Explain methodology only when requested or when a limitation materially affects interpretation. Omit when unnecessary. Put any needed commentary here."
      ),
    table: tableSchema.describe(
      "The table to post. Use plain strings for column headers. Use one row per item, with each cell either a string or { text, url } for a labelled HTTP/HTTPS link. Pass a plain URL, not Markdown or Slack link syntax."
    ),
    title: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Visible table title. Make the measure or contents and relevant time window clear, such as published versus updated content."
      ),
  }),
  outputSchema: visualizationOutputSchema.extend({
    deliveredRows: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Rows delivered, or null when delivery failed."),
    deliveryComplete: z
      .boolean()
      .describe(
        "Successful delivery included all rows without shortened cells; native blocks retain complete data."
      ),
    textRowsShown: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Rows included in the accessible text alternative and fallback."
      ),
    textShortened: z
      .boolean()
      .describe(
        "Text alternative omits rows or shortens cells, disclosed in the message."
      ),
    totalRows: z.number().int().nonnegative().describe("Number of input rows."),
  }),
});
