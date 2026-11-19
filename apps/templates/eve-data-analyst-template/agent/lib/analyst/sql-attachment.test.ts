import { describe, expect, it } from "vitest";

import {
  sqlAttachmentBlock,
  sqlAttachmentMarkdown,
  sqlAttachmentMrkdwn,
  sqlAttachmentPlainBlocks,
} from "./sql-attachment";

const query = (
  index: number,
  tables = ["analytics.subscriptions", "analytics.customers"]
) => ({
  purpose: `Question <${index}> & more`,
  ranAt: `2026-10-10T09:1${index}:00.000Z`,
  sql: `SELECT ${index}`,
  tables,
});

describe(sqlAttachmentBlock, () => {
  it("returns nothing when no query ran", () => {
    expect(sqlAttachmentBlock([])).toBeNull();
    expect(sqlAttachmentMarkdown([])).toBe("");
  });

  it("folds one query with its tables and a localized date", () => {
    expect(sqlAttachmentBlock([query(4)])).toStrictEqual({
      child_blocks: [
        {
          elements: [
            {
              elements: [{ text: "SELECT 4", type: "text" }],
              type: "rich_text_preformatted",
            },
          ],
          type: "rich_text",
        },
        {
          elements: [
            { text: "DB tables: subscriptions, customers", type: "mrkdwn" },
          ],
          type: "context",
        },
        {
          elements: [
            {
              text: "Data as of <!date^1791623640^{date_long} at {time}|October 10, 2026 at 09:14 UTC>",
              type: "mrkdwn",
            },
          ],
          type: "context",
        },
      ],
      default_collapsed: true,
      is_collapsible: true,
      title: { text: "SQL query", type: "plain_text" },
      type: "container",
    });
  });

  it("numbers several queries, escapes labels, and stays within 10 blocks", () => {
    const block = sqlAttachmentBlock([query(1), query(2), query(3)]);
    expect(block?.title).toStrictEqual({
      text: "SQL queries (3)",
      type: "plain_text",
    });
    const children = Array.isArray(block?.child_blocks)
      ? block.child_blocks
      : [];
    expect(children).toHaveLength(10);
    expect(JSON.stringify(children[0])).toContain(
      "*1.* Question &lt;1&gt; &amp; more"
    );
    expect(JSON.stringify(children.at(-1))).toContain("09:13 UTC");
  });

  it("keeps schema names when tables span schemas and truncates long SQL", () => {
    const block = sqlAttachmentBlock([
      {
        ...query(1, ["analytics.plans", "billing.invoices"]),
        sql: "x".repeat(3000),
      },
    ]);
    const json = JSON.stringify(block);
    expect(json).toContain("DB tables: analytics.plans, billing.invoices");
    expect(json).toContain("… [truncated]");
  });
});

describe(sqlAttachmentPlainBlocks, () => {
  it("returns nothing when no query ran", () => {
    expect(sqlAttachmentPlainBlocks([])).toStrictEqual([]);
  });

  it("puts a bold title before the container's child blocks", () => {
    const queries = [query(1), query(2), query(3)];
    const blocks = sqlAttachmentPlainBlocks(queries);
    expect(blocks).toHaveLength(11);
    expect(blocks[0]).toStrictEqual({
      elements: [{ text: "*SQL queries (3)*", type: "mrkdwn" }],
      type: "context",
    });
    expect(blocks.slice(1)).toStrictEqual(
      sqlAttachmentBlock(queries)?.child_blocks
    );
    expect(JSON.stringify(blocks)).not.toContain("container");
  });
});

describe(sqlAttachmentMarkdown, () => {
  it("renders the same queries as Markdown", () => {
    expect(sqlAttachmentMarkdown([query(1), query(2)])).toBe(
      "\n\n**SQL queries (2)**\n\n1. Question <1> & more\n```sql\nSELECT 1\n```\nDB tables: subscriptions, customers\n\n2. Question <2> & more\n```sql\nSELECT 2\n```\nDB tables: subscriptions, customers\n\nData as of October 10, 2026 at 09:12 UTC"
    );
  });

  it("uses a fence longer than any backtick run in the SQL", () => {
    const markdown = sqlAttachmentMarkdown([
      { ...query(1), sql: "SELECT '```' AS x" },
    ]);
    expect(markdown).toContain("````sql\nSELECT '```' AS x\n````\nDB tables:");
    expect(markdown.trimEnd()).toMatch(
      /````\nDB tables: [^\n]+\n\nData as of [^\n]+$/u
    );
  });
});

describe(sqlAttachmentMrkdwn, () => {
  it("returns nothing when no query ran", () => {
    expect(sqlAttachmentMrkdwn([])).toBe("");
  });

  it("renders mrkdwn with escaped SQL and a localized date", () => {
    const mrkdwn = sqlAttachmentMrkdwn([
      { ...query(1), sql: "SELECT a FROM t WHERE b >= 1 AND c <@ d" },
    ]);
    expect(mrkdwn).toBe(
      "\n\n*SQL query*\n\n```\nSELECT a FROM t WHERE b &gt;= 1 AND c &lt;@ d\n```\nDB tables: subscriptions, customers\n\nData as of <!date^1791623460^{date_long} at {time}|October 10, 2026 at 09:11 UTC>"
    );
    expect(mrkdwn).not.toContain("**");
  });

  it("numbers several queries and escapes their purposes", () => {
    const mrkdwn = sqlAttachmentMrkdwn([query(1), query(2)]);
    expect(mrkdwn).toContain("*SQL queries (2)*");
    expect(mrkdwn).toContain(
      "1. Question &lt;1&gt; &amp; more\n```\nSELECT 1\n```"
    );
    expect(mrkdwn).not.toContain("<1>");
  });

  it("breaks up backtick runs so they can't close the code block", () => {
    const mrkdwn = sqlAttachmentMrkdwn([
      { ...query(1), sql: "SELECT '```' AS a, '``````' AS b" },
    ]);
    expect(mrkdwn).toContain(
      "```\nSELECT '`\u200B`\u200B`' AS a, '`\u200B`\u200B`\u200B`\u200B`\u200B`' AS b\n```"
    );
    expect(mrkdwn.match(/```/gu)).toHaveLength(2);
  });
});
