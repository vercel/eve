import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { scheduledRun, slackStubs } from "../lib/slack.ts";

const TASK =
  "Search Slack for incident reports posted in #incidents since yesterday and summarize them.";

export default [
  defineEval({
    description: "A scheduled run told to stay quiet with nothing to report gets no_reply.",
    async test(t) {
      const session = await t.session({ stubs: slackStubs([]) });
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
      const session = await t.session({ stubs: slackStubs([]) });
      const turn = await session.send(scheduledRun(TASK));
      turn.succeeded();
      turn.notCalledTool("no_reply");
      t.judge("The response says no incident reports were found since yesterday.", {
        on: turn.reply,
      }).gate(0.7);
    },
  }),
];
