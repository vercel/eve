/**
 * Slack approval card for expensive run_sql queries.
 *
 * @packageDocumentation
 */
import { inputRequestButtons } from "#lib/integrations/slack/input-requests";
import type { SlackInputRequestsConfig } from "#lib/integrations/slack/input-requests";
import { escapeMrkdwn } from "#lib/slack-text";
import { defineState } from "#lib/state";
import { isString, withRecentEntry } from "#lib/values";

/** Longest SQL excerpt shown on the card. */
const MAX_CARD_SQL = 2500;

/** Most estimates kept; well above the approvals one turn can leave pending. */
const MAX_PENDING_ESTIMATES = 50;

/** Planner estimate recorded when a query needs approval. */
export interface QueryEstimate {
  readonly askerSlackUserId: string | null;
  readonly planRows: number;
  readonly sql: string;
  readonly threshold: number;
  readonly totalCost: number;
}

const estimates = defineState<Record<string, QueryEstimate>>(
  "analyst.query-estimates",
  () => ({})
);

/**
 * Records the estimate shown on a pending approval card.
 *
 * @param callId - Tool call awaiting approval.
 * @param estimate - Planner estimate, threshold, exact SQL, and the asker's Slack user ID.
 * @remarks Keeps only the newest estimates. An older card shows a generic cost line instead.
 */
export const recordQueryEstimate = (
  callId: string,
  estimate: QueryEstimate
): void => {
  estimates.update((current) =>
    withRecentEntry(current, callId, estimate, MAX_PENDING_ESTIMATES)
  );
};

const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);

const excerpt = (sql: string) =>
  sql.length > MAX_CARD_SQL
    ? `${sql.slice(0, MAX_CARD_SQL)}\n… [truncated]`
    : sql;

const plain = (text: string) => ({
  emoji: false,
  text,
  type: "plain_text" as const,
});

/** Renders run_sql approvals with the query's purpose, cost estimate, SQL, and who may answer. */
export const runSqlApprovalCard: SlackInputRequestsConfig = {
  render(request) {
    if (
      request.kind !== "tool-approval" ||
      request.action.toolName !== "run_sql"
    ) {
      return;
    }
    const { callId, input } = request.action;
    const sql = isString(input.sql) ? input.sql : "";
    const purpose =
      isString(input.purpose) && input.purpose ? input.purpose : "Run a query";
    const saved = estimates.get()[callId];
    // Never show an estimate recorded for different SQL.
    const estimate = saved?.sql === sql ? saved : undefined;
    const details = estimate
      ? `Estimated cost ${compact(estimate.totalCost)} (approval needed above ${compact(estimate.threshold)}) · about ${compact(estimate.planRows)} rows`
      : "This query's estimated cost needs approval.";
    const who = estimate?.askerSlackUserId
      ? `Only <@${estimate.askerSlackUserId}> can run or cancel this query.`
      : "Only the person who asked can run or cancel this query.";
    return {
      blocks: [
        { text: plain(`Approve query: ${purpose}`), type: "section" },
        { elements: [{ text: details, type: "plain_text" }], type: "context" },
        {
          elements: [
            {
              elements: [{ text: excerpt(sql), type: "text" }],
              type: "rich_text_preformatted",
            },
          ],
          type: "rich_text",
        },
        {
          elements: inputRequestButtons(request, {
            approve: "Run query",
            cancel: "Cancel",
          }),
          type: "actions",
        },
        { elements: [{ text: who, type: "mrkdwn" }], type: "context" },
      ],
      text: escapeMrkdwn(
        `Approve query: ${purpose}\n${details}\n${excerpt(sql)}`
      ),
    };
  },
};
