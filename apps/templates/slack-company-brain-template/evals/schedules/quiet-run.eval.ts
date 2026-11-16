import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { alice, permalink, scheduledRun, slackStubs } from "../lib/slack.ts";

// One report from last week, so search visibly works but finds nothing since
// yesterday. The run is scheduled for 2026-01-02.
const OLD_REPORT = {
  channelId: "C0INCIDNT",
  channelName: "incidents",
  author: alice.displayName,
  authorUserId: alice.userId,
  ts: "1766908800.000100",
  text: "Resolved: checkout latency spike on Dec 28. Root cause was a cache eviction storm.",
  permalink: permalink("C0INCIDNT", "1766908800.000100"),
};

const TASK =
  "Search Slack for incident reports posted in #incidents since yesterday and summarize them.";

export default [
  defineEval({
    description: "A scheduled run told to stay quiet with nothing to report gets no_reply.",
    async test(t) {
      const session = await t.session({ stubs: slackStubs([OLD_REPORT]) });
      const turn = await session.send(
        scheduledRun(`${TASK} If there are none, stay quiet and post nothing.`),
      );
      turn.succeeded();
      turn.calledTool("no_reply");
      t.check(
        turn.reply ?? "",
        satisfies((reply: string) => reply.trim() === "", "posts no text"),
      );
    },
  }),
  defineEval({
    description: "A scheduled run not told to stay quiet still reports that nothing was found.",
    async test(t) {
      const session = await t.session({ stubs: slackStubs([OLD_REPORT]) });
      const turn = await session.send(scheduledRun(TASK));
      turn.succeeded();
      turn.notCalledTool("no_reply");
      t.judge("The response says no incident reports were found since yesterday.", {
        on: turn.reply,
      }).gate(0.7);
    },
  }),
];
