import type { EveEvalAssertions } from "eve/evals";

export { FALLBACK_REPLY, MODEL_SIGN_IN, MODEL_TOKEN } from "../../../agent/lib/model-sign-in.ts";

/** Alice, on the fixture model that needs her own credential. */
export const asAliceOnOwnCredential = {
  headers: { "x-eve-fixture-model": "own-credential", "x-eve-fixture-user": "alice" },
};

/** Alice, on a dynamic model that falls back to the project's model after she declines. */
export const asAliceWithFallback = {
  headers: { "x-eve-fixture-model": "own-credential-fallback", "x-eve-fixture-user": "alice" },
};

/** Alice, on a parent that delegates to a subagent on her own model credential. */
export const asAliceWithSubagent = {
  headers: { "x-eve-fixture-model": "own-credential-relay", "x-eve-fixture-user": "alice" },
};

/** The sign-in URL as the provider sends it back when the person refuses. */
export function declined(url: URL): URL {
  const refused = new URL(url);
  refused.searchParams.delete("code");
  refused.searchParams.set("error", "access_denied");
  return refused;
}

/** The turn failed with `MODEL_AUTHORIZATION_FAILED`. */
export function expectAuthorizationFailed(on: EveEvalAssertions) {
  on.eventsSatisfy("the turn fails with MODEL_AUTHORIZATION_FAILED", (events) =>
    events.some(
      (event) =>
        event.type === "turn.settled" &&
        event.data.outcome === "failed" &&
        event.data.error?.code === "MODEL_AUTHORIZATION_FAILED",
    ),
  );
}
