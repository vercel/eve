import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { expected, question } from "./shared";

export default defineEval({
  async test(t) {
    const turn = await t.send(`Use the issues__list_issues tool. ${question}`);
    t.succeeded();
    t.calledTool("bash", { input: { command: /jq/ } });
    t.check(turn.reply, includes(expected));
  },
});
