import { defineEval, type EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  alice,
  bob,
  BOT_USER_ID,
  REPORT_FORMATTING,
  slackMessage,
  wordCount,
} from "../lib/slack.ts";

// Alice brings the agent into a thread with a mention. Its later replies
// arrive without one, as they would in a Slack thread the agent follows.
async function startThread(t: EveEvalContext) {
  const first = await t.send(
    slackMessage({
      from: alice,
      text: `<@${BOT_USER_ID}> what does p99 latency mean on our API dashboard?`,
      ts: "1767268800.000100",
      mentioned: true,
    }),
  );
  first.succeeded();
  return first.session;
}

export default [
  defineEval({
    description: "A reply that people send each other gets no_reply and no text.",
    async test(t) {
      const session = await startThread(t);
      const turn = await session.send(
        slackMessage({
          from: bob,
          text: `<@${alice.userId}> I can pair with you on the dashboard after lunch if that helps.`,
          ts: "1767268900.000200",
          mentioned: false,
        }),
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
    description: "A follow-up meant for the agent gets a short, plain-prose thread reply.",
    async test(t) {
      const session = await startThread(t);
      const turn = await session.send(
        slackMessage({
          from: alice,
          text: "Thanks! So is a lower p99 better?",
          ts: "1767268900.000200",
          mentioned: false,
        }),
      );
      turn.succeeded();
      turn.notCalledTool("no_reply");
      t.check(
        wordCount(turn.reply),
        satisfies((words: number) => words > 0 && words <= 120, "a thread-sized reply"),
      );
      t.check(
        turn.reply ?? "",
        satisfies(
          (reply: string) => !REPORT_FORMATTING.test(reply),
          "no headings, bold, or tables",
        ),
      );
      t.judge(
        "The response answers the question directly, with no recap of the thread and no closing " +
          "offer such as 'want me to...?' or 'let me know if...'.",
        { on: turn.reply },
      ).gate(0.7);
    },
  }),
];
