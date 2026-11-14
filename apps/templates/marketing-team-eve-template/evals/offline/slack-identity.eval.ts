import type { SlackMessage } from "eve/channels/slack";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  firstHumanMention,
  isTrustedOnBehalfOfPoster,
  parseIdList,
  slackSessionAuth,
} from "../../agent/lib/slack/config.js";

/**
 * Build the parts of a Slack message the identity rules read.
 *
 * @param overrides - Fields to set on top of a top-level channel message with no author.
 * @returns A message shaped for the identity functions.
 */
const message = (overrides: Record<string, unknown>): SlackMessage =>
  ({
    channelId: "C1",
    raw: {},
    teamId: "T1",
    text: "",
    threadTs: "",
    ts: "100.1",
    ...overrides,
  }) as SlackMessage;

const human = message({ author: { isBot: false, userId: "U1" } });
const workflow = message({
  author: { isBot: true, userId: "UBOT" },
  raw: { bot_id: "BWORKFLOW" },
  text: "<@UAGENT> request from <@U2>",
});

/**
 * Protects the Slack identity rules in `agent/lib/slack/config.ts`.
 *
 * @remarks
 * The principal a session starts with decides whose Notion and Resend grants it runs on and whose
 * preferences it recalls. Two regressions would be silent in normal use: a message with no sender
 * becoming a shared placeholder user, and a bot post acting for a person it merely mentions. Both
 * are asserted here against the pure functions, with no Slack call.
 */
export default defineEval({
  description:
    "Slack identity: unknown senders get no auth, and only allow-listed bots act for a person.",
  test(t) {
    t.check(slackSessionAuth(human)?.principalId, equals("slack:T1:U1"));
    t.check(slackSessionAuth(human)?.principalType, equals("user"));

    t.check(slackSessionAuth(message({})), equals(null));
    t.check(
      slackSessionAuth(message({ raw: { user: "U9" } }))?.principalId,
      equals("slack:T1:U9")
    );

    t.check(
      slackSessionAuth(workflow)?.principalId,
      equals("slack:T1:bot:UBOT")
    );
    t.check(slackSessionAuth(workflow)?.principalType, equals("service"));
    t.check(
      slackSessionAuth(workflow, "U2")?.principalId,
      equals("slack:T1:U2")
    );
    t.check(slackSessionAuth(workflow, "U2")?.principalType, equals("user"));
    t.check(slackSessionAuth(human, "U2")?.principalId, equals("slack:T1:U1"));

    const allowed = parseIdList(" BWORKFLOW , ");
    t.check(isTrustedOnBehalfOfPoster(workflow, allowed), equals(true));
    t.check(
      isTrustedOnBehalfOfPoster(workflow, parseIdList(undefined)),
      equals(false)
    );
    t.check(isTrustedOnBehalfOfPoster(human, parseIdList("U1")), equals(false));

    t.check(firstHumanMention(workflow.text, "UAGENT"), equals("U2"));
    t.check(firstHumanMention("<@UAGENT> hello", "UAGENT"), equals(undefined));
  },
});
