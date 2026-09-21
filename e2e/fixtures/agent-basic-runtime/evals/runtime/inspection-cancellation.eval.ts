import { Client } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Cancelled inspection does not prevent an agent's first chat.",
  async test(t) {
    const client = new Client({ host: t.target.url });
    // Keep the harness's authorization for both local and deployed targets.
    client.fetch = (path, init) => t.target.fetch(path, init);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await client.info({ signal: controller.signal }).then(
      () => false,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await t.require(cancelled, equals(true));
    const info = await client.info();
    await t.require(typeof info.agent.name, equals("string"));
    const turn = await t.send(
      "Alice has finished checking the agent details. Greet her briefly without calling tools.",
    );
    turn.expectOk();
    t.usedNoTools();
    turn.event("message.completed", { count: 1 });
  },
});
