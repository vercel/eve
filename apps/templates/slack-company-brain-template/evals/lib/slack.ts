import type { ToolStub } from "eve/evals";

export const TEAM_ID = "T0ACME001";
export const CHANNEL_ID = "C0ATLAS01";
export const BOT_USER_ID = "U0BRAIN01";

export const alice = { userId: "U0ALICE01", displayName: "Alice Chen" };
export const bob = { userId: "U0BOB0001", displayName: "Bob Rivera" };

/** A Slack search match, in the shape `agent/tools/search_slack.ts` returns. */
export type SearchMatch = {
  readonly channelId: string;
  readonly channelName: string;
  readonly author: string;
  readonly authorUserId: string;
  readonly ts: string;
  readonly text: string;
  readonly permalink: string;
};

export function permalink(channelId: string, ts: string): string {
  return `https://acme.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

/**
 * Stubs both Slack tools: `search_slack` returns `matches`, and
 * `read_slack_conversation` returns each match as its own one-message thread.
 * Outside a Slack turn the real tools report Slack as unavailable.
 */
export function slackStubs(matches: readonly SearchMatch[]): ToolStub[] {
  return [
    { id: "search", tool: "search_slack", outcome: { response: { matches: [...matches] } } },
    {
      id: "read",
      tool: "read_slack_conversation",
      outcome: {
        response: {
          messages: matches.map((match) => ({
            ts: match.ts,
            author: match.author,
            userId: match.authorUserId,
            text: match.text,
          })),
        },
      },
    },
  ];
}

// Matches FOLLOWED_THREAD_GUIDANCE in `agent/channels/slack.ts`.
const FOLLOWED_THREAD_GUIDANCE =
  "You are part of this Slack thread, so you see replies people send each other. This reply " +
  "doesn't mention you. Answer only if it's meant for you or you can clearly help; otherwise " +
  "call `no_reply`.";

/**
 * A message in the block format eve's Slack channel gives the model. Evals run
 * over eve's HTTP channel, so this is how they reproduce a Slack thread. A
 * message without a mention carries the followed-thread guidance.
 */
export function slackMessage(input: {
  readonly from: { readonly userId: string; readonly displayName: string };
  readonly text: string;
  readonly ts: string;
  readonly mentioned: boolean;
}): string {
  return [
    "<slack_message>",
    "<sender>",
    "type: user",
    `id: ${input.from.userId}`,
    `display_name: ${input.from.displayName}`,
    "</sender>",
    "<bot>",
    `id: ${BOT_USER_ID}`,
    `mentioned: ${input.mentioned}`,
    "</bot>",
    "<thread>",
    `team_id: ${TEAM_ID}`,
    `channel_id: ${CHANNEL_ID}`,
    "thread_ts: 1767268800.000100",
    `message_ts: ${input.ts}`,
    "</thread>",
    ...(input.mentioned ? [] : ["<guidance>", FOLLOWED_THREAD_GUIDANCE, "</guidance>"]),
    "<content>",
    input.text,
    "</content>",
    "</slack_message>",
  ].join("\n");
}

/** Words as a reader counts them: a Markdown link counts as its label, not its URL. */
export function wordCount(text: string | undefined): number {
  return (text ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .split(/\s+/u)
    .filter(Boolean).length;
}

/** Markdown structure that a plain thread reply shouldn't have. */
export const REPORT_FORMATTING = /^\s*#{1,6}\s|\*\*[^*]+\*\*|^\s*\|.*\|\s*$|^\s*---\s*$/mu;
