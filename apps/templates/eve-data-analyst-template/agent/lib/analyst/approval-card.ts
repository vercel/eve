/**
 * Slack approval card for expensive run_sql queries.
 *
 * @packageDocumentation
 */
import { ANSWER_ACTION_PREFIX, defineSlackRenderer } from "eve/channels/slack";
import type {
  BlockKitBlock,
  SlackInteractionCard,
  SlackInteractionCardParts,
} from "eve/channels/slack";
import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import { z } from "zod";

import type { JsonObject, JsonValue } from "#lib/json";
import { escapeMrkdwn } from "#lib/slack-text";
import { defineState } from "#lib/state";
import { isObject, isString, withRecentEntry } from "#lib/values";

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

/** Labels for eve's approve and deny buttons on the run_sql card, by option ID. */
const BUTTON_LABELS = new Map<string, string>([
  [APPROVE_OPTION_ID, "Run query"],
  [DENY_OPTION_ID, "Cancel"],
]);

/**
 * Collects every eve answer control in a rendered card, wherever it is nested.
 *
 * @param value - Blocks, or any value inside them.
 * @returns The controls in document order, each an object whose `action_id` starts with eve's answer prefix.
 */
const eveControls = (value: JsonValue): JsonObject[] => {
  if (Array.isArray(value)) {
    return value.flatMap(eveControls);
  }
  if (!isObject(value)) {
    return [];
  }
  const own =
    isString(value.action_id) &&
    value.action_id.startsWith(ANSWER_ACTION_PREFIX)
      ? [value]
      : [];
  return [...own, ...Object.values(value).flatMap(eveControls)];
};

/* One of eve's approve or deny buttons; other keys, such as `action_id` and `style`, pass through. */
const buttonSchema = z.looseObject({
  text: z.looseObject({ text: z.string() }),
  type: z.literal("button"),
  value: z.string(),
});

/* The parts of run_sql's input the card shows; input of another shape reads as empty. */
const inputSchema = z
  .object({ purpose: z.string(), sql: z.string() })
  .partial();

/* The estimate saved for a call, or undefined outside a session step, where state can't be read. */
const savedEstimate = (callId: string): QueryEstimate | undefined => {
  try {
    return estimates.get()[callId];
  } catch {
    return undefined;
  }
};

/* How an answered or ended request reads on the card. */
const endingLabel = ({
  answer,
  outcome,
}: SlackInteractionCard["interaction"]) => {
  const decision = answer?.optionId;
  if (decision === APPROVE_OPTION_ID || (!answer && outcome === "accepted")) {
    return "Approved";
  }
  if (decision === DENY_OPTION_ID || (!answer && outcome === "declined")) {
    return "Cancelled";
  }
  return "No longer needed";
};

/* What the card says about one run_sql call. */
interface QuerySummary {
  readonly askerSlackUserId: string | null;
  /* The planner's estimate, or null when none was saved for this exact SQL. */
  readonly cost: string | null;
  readonly sql: string;
  readonly title: string;
}

const GENERIC_COST = "This query's estimated cost needs approval.";

const describeQuery = (
  call: NonNullable<SlackInteractionCard["interaction"]["call"]>
): QuerySummary => {
  const input = inputSchema.safeParse(call.input);
  const sql = input.data?.sql ?? "";
  const saved = savedEstimate(call.callId);
  // Never show an estimate recorded for different SQL.
  const estimate = saved?.sql === sql ? saved : undefined;
  return {
    askerSlackUserId: estimate?.askerSlackUserId ?? null,
    cost: estimate
      ? `Estimated cost ${compact(estimate.totalCost)} (approval needed above ${compact(estimate.threshold)}) · about ${compact(estimate.planRows)} rows`
      : null,
    sql,
    title: `Approve query: ${input.data?.purpose || "Run a query"}`,
  };
};

/* The blocks every state of the card shares: the title, a cost line, and the SQL. */
const summaryBlocks = (
  { sql, title }: QuerySummary,
  cost: string | null
): BlockKitBlock[] => [
  { text: plain(title), type: "section" },
  ...(cost
    ? [{ elements: [{ text: cost, type: "plain_text" }], type: "context" }]
    : []),
  // Slack refuses an empty text element.
  ...(sql
    ? [
        {
          elements: [
            {
              elements: [{ text: excerpt(sql), type: "text" }],
              type: "rich_text_preformatted",
            },
          ],
          type: "rich_text",
        },
      ]
    : []),
];

/* The card once the request is answered or ended: a record of what was asked, without controls. */
const endedCard = (
  card: SlackInteractionCard,
  query: QuerySummary
): SlackInteractionCardParts => {
  const label = endingLabel(card.interaction);
  const by = card.answeredBy ? ` by <@${card.answeredBy}>` : "";
  return {
    controls: {
      blocks: [
        // The estimate stays as a record; without one the card says nothing about cost.
        ...summaryBlocks(query, query.cost),
        {
          elements: [{ text: `${label}${by}`, type: "mrkdwn" }],
          type: "context",
        },
      ],
      text: escapeMrkdwn(`${query.title}\n${label}`),
    },
  };
};

/* The card while it waits for an answer, with eve's buttons relabelled. */
const openCard = (
  query: QuerySummary,
  buttons: readonly z.infer<typeof buttonSchema>[]
): SlackInteractionCardParts => {
  const cost = query.cost ?? GENERIC_COST;
  const who = query.askerSlackUserId
    ? `Only <@${query.askerSlackUserId}> can run or cancel this query.`
    : "Only the person who asked can run or cancel this query.";
  return {
    controls: {
      blocks: [
        ...summaryBlocks(query, cost),
        {
          elements: buttons.map((button) => ({
            ...button,
            text: plain(BUTTON_LABELS.get(button.value) ?? button.text.text),
          })),
          type: "actions",
        },
        { elements: [{ text: who, type: "mrkdwn" }], type: "context" },
      ],
      text: escapeMrkdwn(`${query.title}\n${cost}\n${excerpt(query.sql)}`),
    },
  };
};

/**
 * Builds the run_sql approval card from eve's default card.
 *
 * @param card - The approval as eve is about to post or update it.
 * @param parts - eve's default messages for it, which hold eve's buttons while the request is open.
 * @returns The card with the query's purpose, cost estimate, SQL, and who may answer, or eve's default when an open request's controls aren't plain buttons.
 * @remarks eve checks that an open card holds exactly its own controls and that an answered or ended card holds none, so the buttons are eve's with only their labels changed.
 */
const runSqlCard = (
  card: SlackInteractionCard,
  parts: SlackInteractionCardParts
): SlackInteractionCardParts => {
  const { answer, call, status } = card.interaction;
  if (!call) {
    return parts;
  }
  // The same test eve applies: an open request without an accepted answer shows its controls.
  if (status !== "open" || answer !== undefined) {
    return endedCard(card, describeQuery(call));
  }
  const buttons = z
    .array(buttonSchema)
    .safeParse(eveControls(z.array(z.json()).parse(parts.controls.blocks)));
  // Without eve's buttons nobody could answer, so keep eve's own card.
  return buttons.success && buttons.data.length > 0
    ? openCard(describeQuery(call), buttons.data)
    : parts;
};

/**
 * Slack renderer that shows run_sql approvals with the query's purpose, cost estimate, SQL, and who may answer.
 *
 * @remarks Restyles eve's approval card through `interactionCard`, so eve still posts the card, routes clicks, tells a refused responder why, and updates the card when the request is answered or ends. Other tools' approvals, questions, and budget prompts keep eve's default card.
 */
export const runSqlApprovalCard = defineSlackRenderer({
  interactionCard(card, renderDefault) {
    const parts = renderDefault(card);
    const { call, request } = card.interaction;
    return request.kind === "approval" && call?.name === "run_sql"
      ? runSqlCard(card, parts)
      : parts;
  },
});
