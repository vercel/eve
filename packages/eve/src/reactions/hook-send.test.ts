import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { pendingPreemptibleSends, REACTIONS_STATE_KEY, type PendingSend } from "./hook-send.js";

const alice = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};

function yielding(message: string, auth: DeliverHookPayload["auth"]): PendingSend {
  return {
    delivery: { auth, kind: "deliver", payloads: [{ message }], turnPolicy: "queue" },
    preemptible: { turnId: "turn-1" },
  };
}

const messages = (sends: readonly PendingSend[]) =>
  pendingPreemptibleSends({ [REACTIONS_STATE_KEY]: { sends } }, "turn-1").map(
    ({ payloads }) => payloads[0]?.message,
  );

describe("pendingPreemptibleSends", () => {
  it("takes the messages that share the first one's turn", () => {
    expect(
      messages([
        yielding("Keep going.", alice),
        yielding("Audit it.", null),
        yielding("Fix the lint errors.", alice),
      ]),
    ).toEqual(["Keep going.", "Fix the lint errors."]);
  });

  it("takes only the first anonymous message, since each runs as its own turn", () => {
    expect(
      messages([yielding("Keep going.", null), yielding("Fix the lint errors.", null)]),
    ).toEqual(["Keep going."]);
  });
});
