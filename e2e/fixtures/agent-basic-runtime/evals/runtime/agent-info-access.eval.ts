import { Client, ClientError } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

// The channel admits this credential as an ordinary end user without an agent-info grant.
const ALICE_AUTHORIZATION = "Bearer e2e-create-once-a";

export default defineEval({
  description:
    "Alice signs in to the web app as an ordinary user, so the agent's operator details stay closed to her.",
  async test(t) {
    const client = new Client({ baseUrl: t.target.url });
    // Keep the harness's deployment access while presenting Alice's credential.
    client.fetch = (path, init) =>
      t.target.fetch(path, { ...init, headers: { authorization: ALICE_AUTHORIZATION } });
    const refusal = await client.info().then(
      () => "served",
      (error: unknown) =>
        error instanceof ClientError ? { code: error.code, status: error.status } : String(error),
    );
    await t.require(refusal, equals({ code: "info_forbidden", status: 403 }));
  },
});
