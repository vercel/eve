import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Vercel image: post-open initialization runs once across turns.",
  async test(t) {
    const command = "cat /workspace/.eve/initialization-count";
    const first = await t.send(
      `Run the bash command \`${command}\` and reply with the command output verbatim.`,
    );
    const second = await t.send(
      `Run the bash command \`${command}\` and reply with the command output verbatim.`,
    );
    t.succeeded();
    t.check(first.message, includes("1"));
    t.check(second.message, includes("1"));
  },
});
