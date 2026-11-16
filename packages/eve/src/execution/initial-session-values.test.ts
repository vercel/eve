import { describe, expect, it } from "vitest";

import { createDurableSessionValues } from "#execution/durable-session-store.js";
import { createInitialSessionValues } from "#execution/initial-session-values.js";
import { createSession } from "#execution/session.js";
import { withPendingHistory } from "#execution/session/pending-history.js";

describe("createInitialSessionValues", () => {
  // It skips the HITL state read `createDurableSessionValues` makes, so both must agree.
  it.each([
    { name: "a bare session", input: { continuationToken: "", sessionId: "s1" } },
    {
      name: "a session with history, an output schema and a root",
      input: {
        continuationToken: "eve:alias",
        history: [{ role: "user" as const, text: "earlier" }],
        outputSchema: { type: "object" },
        rootSessionId: "root",
        sessionId: "s2",
      },
    },
  ])("matches the durable values of $name", ({ input }) => {
    const created = createSession(input);
    const state = withPendingHistory(created.state, input.history);
    const expected = createDurableSessionValues(
      state === created.state ? created : { ...created, state },
    );
    expect(createInitialSessionValues(input)).toEqual({
      history: expected.history,
      state: expected.sessionState,
    });
  });
});
