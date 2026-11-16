import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { alice, bob, CHANNEL_ID, permalink, slackStubs } from "../lib/slack.ts";

const decision = {
  channelId: CHANNEL_ID,
  channelName: "proj-atlas",
  author: alice.displayName,
  authorUserId: alice.userId,
  ts: "1767268800.000100",
  text: "Decision: the Atlas launch moves to Thursday, March 12, so the billing migration can finish first.",
  permalink: permalink(CHANNEL_ID, "1767268800.000100"),
};

const reminder = {
  channelId: "C0ENGANN1",
  channelName: "eng-announcements",
  author: bob.displayName,
  authorUserId: bob.userId,
  ts: "1767355200.000200",
  text: "Reminder: the Atlas launch checklist review is on Tuesday.",
  permalink: permalink("C0ENGANN1", "1767355200.000200"),
};

export default defineEval({
  description: "A sourced answer links the exact permalink inline, without a Sources section.",
  async test(t) {
    const session = await t.session({ stubs: slackStubs([decision, reminder]) });
    const turn = await session.send(
      "Search Slack: what did the team decide about the Atlas launch date?",
    );
    turn.succeeded();
    turn.calledTool("search_slack");
    t.check(turn.reply, includes(/March 12|Thursday/u));
    t.check(turn.reply, includes(`](${decision.permalink})`));
    t.check(
      turn.reply ?? "",
      satisfies(
        (reply: string) => !/^\s*(?:#{1,6}\s*|\*{1,2})?Sources\b/imu.test(reply),
        "no separate Sources section",
      ),
    );
    t.check(
      turn.reply ?? "",
      satisfies((reply: string) => !/\[\^?\d+\]/u.test(reply), "no numbered citation markers"),
    );
    t.judge(
      "Every link's text describes the source or the fact it supports (for example 'the " +
        "decision in #proj-atlas'), not 'here', 'source', or a bare URL, and the link sits in " +
        "the sentence that makes the claim.",
      { on: turn.reply },
    ).gate(0.7);
  },
});
