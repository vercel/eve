import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import type config from "../evals.config.js";

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export default defineEval<typeof config>({
  description:
    "Finds the biggest traffic source over the last 10 complete days, excluding bots.",
  async test(t) {
    const { truth } = t.context;
    const turn = await t.send(
      "What was our biggest source of traffic over the last 10 days?"
    );
    t.succeeded();
    t.calledTool("run_sql", { input: { sql: /is_bot/iu } });
    t.check(
      turn.message,
      includes(new RegExp(escapeRegExp(truth.topSourceLast10Days), "iu"))
    );
  },
});
