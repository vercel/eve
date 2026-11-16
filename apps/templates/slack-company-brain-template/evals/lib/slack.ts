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

function readMessage(match: SearchMatch) {
  return { ts: match.ts, author: match.author, userId: match.authorUserId, text: match.text };
}

/**
 * Stubs both Slack tools so every read matches what search returned:
 *
 * - `search_slack` returns `matches`.
 * - Reading a match's thread returns that match alone, as a one-message thread.
 * - Reading any other thread returns no messages.
 * - Reading a channel returns that channel's matches, newest first.
 * - Reading any other channel returns no messages.
 *
 * Stubs match in order, so thread reads are caught before channel reads.
 * Outside a Slack turn the real tools report Slack as unavailable, so every
 * read must hit a stub.
 */
export function slackStubs(matches: readonly SearchMatch[]): ToolStub[] {
  const channels = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    channels.set(match.channelId, [...(channels.get(match.channelId) ?? []), match]);
  }
  return [
    { id: "search", tool: "search_slack", outcome: { response: { matches: [...matches] } } },
    ...matches.map((match, index): ToolStub => ({
      id: `read-thread-${index}`,
      tool: "read_slack_conversation",
      match: { channelId: { const: match.channelId }, threadTs: { const: match.ts } },
      outcome: {
        response: {
          channel: match.channelName,
          permalink: match.permalink,
          messages: [readMessage(match)],
        },
      },
    })),
    {
      id: "read-other-thread",
      tool: "read_slack_conversation",
      match: { threadTs: true },
      outcome: { response: { messages: [] } },
    },
    ...[...channels].map(([channelId, channelMatches]): ToolStub => ({
      id: `read-channel-${channelId}`,
      tool: "read_slack_conversation",
      match: { channelId: { const: channelId } },
      outcome: {
        response: {
          channel: channelMatches[0]!.channelName,
          messages: [...channelMatches]
            .sort((a, b) => Number(b.ts) - Number(a.ts))
            .map(readMessage),
        },
      },
    })),
    { id: "read-other", tool: "read_slack_conversation", outcome: { response: { messages: [] } } },
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

/**
 * The message a scheduled run sends the agent. Matches `run` in
 * `agent/schedules/tasks.ts`.
 */
export function scheduledRun(task: string): string {
  return [
    `Run this scheduled task for <@${alice.userId}> now and post the result.`,
    "If the task says to stay quiet when there's nothing to report and there isn't, call `no_reply` instead.",
    "No one is present to answer questions or approve actions. If you can't finish, say what's missing.",
    "Schedule: Morning incident check",
    "Scheduled for: 2026-01-02T17:00:00.000Z",
    `Task: ${task}`,
  ].join("\n");
}
