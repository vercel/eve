/**
 * Folded "SQL query" section attached to Slack replies, built from the queries that actually ran.
 *
 * @packageDocumentation
 */
import type { LoggedQuery } from "#lib/analyst/query-log";
import type { JsonObject } from "#lib/json";
import { escapeMrkdwn, escapeMrkdwnCode } from "#lib/slack-text";

/** Longest SQL shown for one query. */
const MAX_SQL_CHARS = 2500;

const truncate = (sql: string) =>
  sql.length > MAX_SQL_CHARS
    ? `${sql.slice(0, MAX_SQL_CHARS)}\n… [truncated]`
    : sql;

/* Drops the schema prefix when every table shares one schema, as in the default single-schema setup. */
const tableNames = (queries: readonly LoggedQuery[]) => {
  const schemas = new Set(
    queries.flatMap((query) => query.tables.map((table) => table.split(".")[0]))
  );
  const short = schemas.size <= 1;
  return (tables: readonly string[]) =>
    tables
      .map((table) => (short ? table.slice(table.indexOf(".") + 1) : table))
      .join(", ");
};

const utcLabel = (date: Date) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(date)} at ${date.toISOString().slice(11, 16)} UTC`;

/* Slack renders the date token in each reader's own time zone, falling back to the UTC label. */
const dataAsOf = (ranAt: string) => {
  const date = new Date(ranAt);
  return `Data as of <!date^${Math.floor(date.getTime() / 1000)}^{date_long} at {time}|${utcLabel(date)}>`;
};

const title = (count: number) =>
  count === 1 ? "SQL query" : `SQL queries (${count})`;

const context = (text: string): JsonObject => ({
  elements: [{ text, type: "mrkdwn" }],
  type: "context",
});

/* The queries as blocks: a label, the SQL, and its tables for each, plus one "Data as of" line. */
const queryBlocks = (queries: readonly LoggedQuery[]): JsonObject[] => {
  const last = queries.at(-1);
  if (!last) {
    return [];
  }
  const names = tableNames(queries);
  const numbered = queries.length > 1;
  return [
    ...queries.flatMap((query, index): JsonObject[] => [
      ...(numbered
        ? [context(`*${index + 1}.* ${escapeMrkdwn(query.purpose)}`)]
        : []),
      {
        elements: [
          {
            elements: [{ text: truncate(query.sql), type: "text" }],
            type: "rich_text_preformatted",
          },
        ],
        type: "rich_text",
      },
      ...(query.tables.length > 0
        ? [context(`DB tables: ${escapeMrkdwn(names(query.tables))}`)]
        : []),
    ]),
    context(dataAsOf(last.ranAt)),
  ];
};

/**
 * Builds the folded Slack container listing the queries behind a reply.
 *
 * @param queries - Successful queries from the turn, oldest first; at most three.
 * @returns A collapsed `container` block, or null when no query ran.
 * @remarks Three queries use exactly the container's 10-block limit: a label, the SQL, and its tables for each, plus one "Data as of" line.
 */
export const sqlAttachmentBlock = (
  queries: readonly LoggedQuery[]
): JsonObject | null =>
  queries.length > 0
    ? {
        child_blocks: queryBlocks(queries),
        default_collapsed: true,
        is_collapsible: true,
        title: { text: title(queries.length), type: "plain_text" },
        type: "container",
      }
    : null;

/**
 * Builds the same queries as top-level blocks, for when Slack refuses the container.
 *
 * @param queries - Successful queries from the turn, oldest first.
 * @returns A bold title line followed by the container's child blocks, or an empty array when no query ran.
 * @remarks Uses only `context` and `rich_text` blocks, so the SQL stays visible where `container` isn't accepted. Three queries take 11 blocks.
 */
export const sqlAttachmentPlainBlocks = (
  queries: readonly LoggedQuery[]
): JsonObject[] =>
  queries.length > 0
    ? [context(`*${title(queries.length)}*`), ...queryBlocks(queries)]
    : [];

/* A Markdown fence longer than any backtick run in the SQL, so the SQL can't close it. */
const fence = (sql: string) =>
  "`".repeat(
    Math.max(3, ...[...sql.matchAll(/`+/gu)].map(([run]) => run.length + 1))
  );

const markdownSql = (sql: string) => {
  const text = truncate(sql);
  const marks = fence(text);
  return `${marks}sql\n${text}\n${marks}`;
};

/**
 * Renders the same queries as Markdown, for when Slack refuses the blocks or the reply becomes a file.
 *
 * @param queries - Successful queries from the turn, oldest first.
 * @returns Markdown starting with a blank line, or an empty string when no query ran.
 */
export const sqlAttachmentMarkdown = (
  queries: readonly LoggedQuery[]
): string => {
  const last = queries.at(-1);
  if (!last) {
    return "";
  }
  const names = tableNames(queries);
  const numbered = queries.length > 1;
  const sections = queries.map((query, index) =>
    [
      numbered ? `${index + 1}. ${query.purpose}` : "",
      markdownSql(query.sql),
      query.tables.length > 0 ? `DB tables: ${names(query.tables)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  return `\n\n**${title(queries.length)}**\n\n${sections.join("\n\n")}\n\nData as of ${utcLabel(new Date(last.ranAt))}`;
};

/**
 * Renders the same queries as Slack mrkdwn, for a message's top-level `text`.
 *
 * @param queries - Successful queries from the turn, oldest first.
 * @returns mrkdwn starting with a blank line, or an empty string when no query ran.
 * @remarks Escapes `&`, `<`, and `>` in the purpose, SQL, and table names, breaks up backtick runs that would close the code block, and uses Slack's localized date token for "Data as of".
 */
export const sqlAttachmentMrkdwn = (
  queries: readonly LoggedQuery[]
): string => {
  const last = queries.at(-1);
  if (!last) {
    return "";
  }
  const names = tableNames(queries);
  const numbered = queries.length > 1;
  const sections = queries.map((query, index) =>
    [
      numbered ? `${index + 1}. ${escapeMrkdwn(query.purpose)}` : "",
      `\`\`\`\n${escapeMrkdwnCode(truncate(query.sql))}\n\`\`\``,
      query.tables.length > 0
        ? `DB tables: ${escapeMrkdwn(names(query.tables))}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  return `\n\n*${title(queries.length)}*\n\n${sections.join("\n\n")}\n\n${dataAsOf(last.ranAt)}`;
};
