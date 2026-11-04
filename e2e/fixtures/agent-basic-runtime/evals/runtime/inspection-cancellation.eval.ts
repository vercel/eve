import { Client, ClientError } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

// The channel admits this credential as an ordinary end user without an agent-info grant.
const ALICE_AUTHORIZATION = "Bearer e2e-create-once-a";

export default defineEval({
  description:
    "Cancelled inspection does not prevent an agent's first chat, and an ordinary user can't read operator details.",
  async test(t) {
    const client = new Client({ baseUrl: t.target.url });
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

    const alice = new Client({ baseUrl: t.target.url });
    // Keep the harness's deployment access while presenting Alice's credential.
    alice.fetch = (path, init) =>
      t.target.fetch(path, { ...init, headers: { authorization: ALICE_AUTHORIZATION } });
    const refusal = await alice.info().then(
      () => "served",
      (error: unknown) =>
        error instanceof ClientError ? { code: error.code, status: error.status } : String(error),
    );
    await t.require(refusal, equals({ code: "info_forbidden", status: 403 }));

    const turn = await t.send(
      "Alice has finished checking the agent details. Greet her briefly without calling tools.",
    );
    turn.expectOk();
    t.usedNoTools();
    turn.event("content.completed", { count: 1, data: { kind: "text", phase: "reply" } });
  },
});
