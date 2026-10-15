import { Client, ClientError } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Metadata-only sessions lose their durable transcript after reset, while full-capture sessions retain it.",
  async test(t) {
    const host = `https://${crypto.randomUUID()}.invalid`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === host
        ? t.target.fetch(`${url.pathname}${url.search}`, init)
        : originalFetch(input, init);
    };
    try {
      for (const metadataOnly of [false, true]) {
        const client = new Client({
          host,
          headers: metadataOnly ? { authorization: "Bearer e2e-metadata-retention" } : {},
        });
        const { session, response } = await client.sessions.create({
          message:
            "Alice has finished reviewing her notes. Greet her briefly without calling tools.",
          signal: t.signal,
        });
        const result = await response.result();
        await t.require(result.status, equals("completed"));
        const live = await session.snapshot({ signal: t.signal });
        await t.require(
          live.events.some((event) => event.type === "message.completed"),
          equals(true),
        );

        const reset = await session.reset({ signal: t.signal });
        await t.require(reset.status, equals("reset"));
        if (!metadataOnly) {
          const retained = await session.snapshot({ signal: t.signal });
          await t.require(
            retained.events.some((event) => event.type === "message.completed"),
            equals(true),
          );
          continue;
        }

        let expired = false;
        for (const delayMs of [0, 50, 100, 200, 400, 800, 1_600, 3_200]) {
          await t.sleep(delayMs);
          try {
            await session.snapshot({ signal: t.signal });
          } catch (error) {
            if (!(error instanceof ClientError) || error.code !== "session_expired") throw error;
            await t.require(error.status, equals(410));
            expired = true;
            break;
          }
        }
        await t.require(expired, equals(true));
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
