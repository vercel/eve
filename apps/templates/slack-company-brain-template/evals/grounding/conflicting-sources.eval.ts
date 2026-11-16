import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { alice, bob, CHANNEL_ID, permalink, slackStubs } from "../lib/slack.ts";

const engineering = {
  channelId: CHANNEL_ID,
  channelName: "proj-atlas",
  author: alice.displayName,
  authorUserId: alice.userId,
  ts: "1767268800.000100",
  text: "Atlas launches on Thursday, March 12. Engineering is on track for that date.",
  permalink: permalink(CHANNEL_ID, "1767268800.000100"),
};

const sales = {
  channelId: "C0SALES01",
  channelName: "sales-atlas",
  author: bob.displayName,
  authorUserId: bob.userId,
  ts: "1767441600.000300",
  text: "Heads up: customers were told Atlas launches on Monday, March 16.",
  permalink: permalink("C0SALES01", "1767441600.000300"),
};

export default defineEval({
  description: "When sources disagree, the answer says so instead of picking one silently.",
  async test(t) {
    const session = await t.session({ stubs: slackStubs([engineering, sales]) });
    const turn = await session.send("Search Slack: when does Atlas launch?");
    turn.succeeded();
    turn.calledTool("search_slack");
    t.check(turn.reply, includes(/March 12|Thursday/u));
    t.check(turn.reply, includes(/March 16|Monday/u));
    t.judge(
      "The response says the two Slack messages give different launch dates (March 12 and " +
        "March 16) and attributes each date to its message, rather than stating one date as " +
        "settled.",
      { on: turn.reply },
    ).gate(0.7);
  },
});
