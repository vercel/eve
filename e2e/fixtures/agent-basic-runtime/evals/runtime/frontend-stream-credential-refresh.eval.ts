import { waitForStore, interceptFetchOrigin } from "@eve-e2e/config/frontend";
import { SessionStore } from "eve/client";
import { delivery } from "eve/events";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "A frontend stream reconnect uses the latest send's authorization header.",
  async test(t) {
    const session = await t.session();
    const host = `https://${crypto.randomUUID()}.invalid`;
    let resolveReconnectAuthorization!: (authorization: string | null) => void;
    const reconnectAuthorization = new Promise<string | null>((resolve) => {
      resolveReconnectAuthorization = resolve;
    });
    let disconnectStream: (() => void) | undefined;
    let awaitingForcedReconnect = false;
    const store = new SessionStore({
      baseUrl: host,
      initialSession: session.state,
    });

    const unregisterFetch = interceptFetchOrigin(host, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const forcedReconnect = awaitingForcedReconnect;
      const response = await t.target.fetch(`${url.pathname}${url.search}`, init);
      if (!url.pathname.endsWith("/stream") || !response.ok || response.body === null) {
        return response;
      }
      if (forcedReconnect) {
        resolveReconnectAuthorization(new Headers(init?.headers).get("authorization"));
        return response;
      }
      const transport = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          disconnectStream = () => {
            awaitingForcedReconnect = true;
            controller.terminate();
          };
        },
      });
      return new Response(response.body.pipeThrough(transport), response);
    });

    try {
      const first = await store.send({
        message: "Reply with first.",
        headers: { authorization: "Bearer old" },
        signal: t.abortSignal,
      });
      await waitForStore(
        store,
        (snapshot) => delivery(snapshot.view, first.deliveryId)?.status === "settled",
        t.abortSignal,
      );
      await t.require(store.snapshot.error, equals(undefined));
      const firstTurn = await t.target.attach(session.id).watch().result();
      firstTurn.expectOk();

      const second = await store.send({
        message: "Reply with second.",
        headers: { authorization: "Bearer fresh" },
        signal: t.abortSignal,
      });
      await waitForStore(
        store,
        (snapshot) => delivery(snapshot.view, second.deliveryId)?.status === "settled",
        t.abortSignal,
      );
      await t.require(store.snapshot.error, equals(undefined));

      if (disconnectStream === undefined)
        throw new Error("The first turn never opened its stream.");
      disconnectStream();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const authorization = await Promise.race([
          reconnectAuthorization,
          new Promise<string | null>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Frontend stream did not reconnect within 20 seconds.")),
              20_000,
            );
            onAbort = () => reject(t.abortSignal.reason);
            if (t.abortSignal.aborted) onAbort();
            else t.abortSignal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        await t.require(authorization, equals("Bearer fresh"));
      } finally {
        clearTimeout(timeout);
        if (onAbort) t.abortSignal.removeEventListener("abort", onAbort);
      }
    } finally {
      try {
        store.newSession();
      } finally {
        unregisterFetch();
      }
    }
  },
});
