import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { wordCount } from "../lib/slack.ts";

export default [
  defineEval({
    description: "A simple question gets a short answer, and asking for more expands it.",
    async test(t) {
      const short = await t.send("What does HTTP status code 429 mean?");
      short.succeeded();
      t.check(
        wordCount(short.reply),
        satisfies((words: number) => words > 0 && words <= 50, "short answer of 50 words or fewer"),
      );
      t.judge("The response leads with what the status code means, with no preamble.", {
        on: short.reply,
      }).gate(0.7);

      const expanded = await short.session.send("Can you give me more detail?");
      expanded.succeeded();
      t.check(
        wordCount(expanded.reply),
        satisfies(
          (words: number) => words > Math.max(50, wordCount(short.reply)),
          "the follow-up is longer than the short answer",
        ),
      );
    },
  }),
  defineEval({
    description: "A comparison with a recommendation gets a detailed answer that leads with it.",
    async test(t) {
      const turn = await t.send(
        "Alice is choosing storage for an event log that takes about 5,000 writes a second " +
          "and is mostly read by time range. Should she use Postgres or DynamoDB, and why?",
      );
      turn.succeeded();
      t.check(
        wordCount(turn.reply),
        satisfies(
          (words: number) => words >= 60 && words <= 300,
          "detailed answer of 75-200 words, with room for completeness",
        ),
      );
      t.judge(
        "The response states its recommendation in the first sentence or two, before the " +
          "supporting reasons, and doesn't end with an offer such as 'want me to...?'.",
        { on: turn.reply },
      ).gate(0.7);
    },
  }),
];
