import { EveAgentStore, defaultMessageReducer } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "A frontend stream reconnect uses the latest send's authorization header.",
  async test(t) {
    const session = await t.session();
    const host = `https://${crypto.randomUUID()}.invalid`;
    const originalFetch = globalThis.fetch;
    let resolveReconnectAuthorization!: (authorization: string | null) => void;
    const reconnectAuthorization = new Promise<string | null>((resolve) => {
      resolveReconnectAuthorization = resolve;
    });
    let disconnectStream: (() => void) | undefined;
    const store = new EveAgentStore({
      host,
      initialSession: session.state,
      reducer: defaultMessageReducer(),
    });

    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== host) return originalFetch(input, init);
      const response = await t.target.fetch(`${url.pathname}${url.search}`, init);
      if (!url.pathname.endsWith("/stream") || !response.ok || response.body === null) {
        return response;
      }
      if (disconnectStream !== undefined) {
        resolveReconnectAuthorization(new Headers(init?.headers).get("authorization"));
        return response;
      }
      const transport = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          disconnectStream = () => controller.terminate();
        },
      });
      return new Response(response.body.pipeThrough(transport), response);
    };

    try {
      await store.send({
        message: "Reply with first.",
        headers: { authorization: "Bearer old" },
        signal: t.signal,
      });
      await t.require(store.snapshot.error, equals(undefined));
      const firstTurn = await t.target.watchTurn(session.sessionId).result();
      firstTurn.expectOk();

      await store.send({
        message: "Reply with second.",
        headers: { authorization: "Bearer fresh" },
        signal: t.signal,
      });
      await t.require(store.snapshot.error, equals(undefined));

      if (disconnectStream === undefined)
        throw new Error("The first turn never opened its stream.");
      disconnectStream();
      await t.require(await reconnectAuthorization, equals("Bearer fresh"));
    } finally {
      store.reset();
      globalThis.fetch = originalFetch;
    }
  },
});
