import { searchSlack, type SlackSearchMatch, type SlackSearchOutcome } from "./slack-api.js";
import type { SlackTurn } from "./turn.js";

type SlackSearchPage = Exclude<SlackSearchOutcome, { readonly tokenExpired: true }>;

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly onDate?: string;
  readonly cursor?: string;
}

const NO_SLACK_MESSAGE = {
  unavailable: true,
  reason: "no_slack_message",
  message:
    "Slack search works in a turn started by a Slack message, because Slack authorizes each search with that message, or for a person who signed in to Slack. This turn has neither, so do not retry search. To read a specific channel or thread, use the read_conversation tool. Report what you could not check as unavailable, never as 'no activity'.",
} as const;

const TOKEN_EXPIRED = {
  unavailable: true,
  reason: "search_token_expired",
  message:
    "Slack search is done for this turn: the short-lived authorization from the user's Slack message has expired and cannot be refreshed until they send another message. Do not retry search or ask the user to search for you. Keep working from what you already retrieved, read specific channels with the read_conversation tool, and briefly name the searches that could not run.",
} as const;

/**
 * Searches with the turn's action token, or with the caller's user token when the turn has none
 * or it expired, and drops matches from channels the caller may not see.
 */
export async function executeSearch(input: SearchInput, turn: SlackTurn) {
  if (turn.actionToken) {
    const outcome = await searchSlack(turn.request, { ...input, actionToken: turn.actionToken });
    if (!("tokenExpired" in outcome)) return authorizedPage(outcome, turn);
  }
  const userRequest = await turn.userRequest();
  if (!userRequest) return turn.actionToken ? TOKEN_EXPIRED : NO_SLACK_MESSAGE;
  const outcome = await searchSlack(userRequest, input);
  if ("tokenExpired" in outcome) return TOKEN_EXPIRED;
  return authorizedPage(outcome, turn);
}

async function authorizedPage(outcome: SlackSearchPage, turn: SlackTurn) {
  // One policy call per channel, not per match; a match without a channel can't be checked, so
  // it is withheld.
  const channelIds = [
    ...new Set(outcome.matches.flatMap((match) => (match.channelId ? [match.channelId] : []))),
  ];
  const allowedIds = new Set(
    (
      await Promise.all(
        channelIds.map(async (channelId) =>
          (await turn.authorize({ tool: "search", channelId })) ? [channelId] : [],
        ),
      )
    ).flat(),
  );
  const matches: SlackSearchMatch[] = outcome.matches.filter(
    (match) => match.channelId !== undefined && allowedIds.has(match.channelId),
  );
  const withheld = outcome.matches.length - matches.length;
  const page = { query: outcome.query, matches, nextCursor: outcome.nextCursor };
  if (withheld === 0) return page;
  return {
    ...page,
    withheld,
    note: `${withheld} match(es) came from channels this caller may not read and were withheld. Do not speculate about them.`,
  };
}
