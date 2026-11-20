import { defineEval } from "eve/evals";
import { includes, equals } from "eve/evals/expect";
import { postChannel } from "./shared";

export default defineEval({
  description:
    "A subscription the channel's onSubscription denies fails with its message and holds nothing.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic model's subscription script.");
    }

    const project = `denied-${crypto.randomUUID()}`;
    const attempt = await t.send(`SUBSCRIBE ${project}`);
    attempt.expectOk();
    attempt.calledTool("eve__subscribe", { count: 1, status: "failed" });
    await t.require(attempt.reply ?? "", includes(`Project ${project} may not be watched.`));

    const emitted = await postChannel<{ delivered: boolean }>(t.target, "/events/emit", {
      event: "build.failed",
      id: `denied-${crypto.randomUUID()}`,
      project,
    });
    await t.require(emitted.delivered, equals(false));
  },
});
