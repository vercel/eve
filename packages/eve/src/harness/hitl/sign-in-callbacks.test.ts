import { describe, expect, it, vi } from "vitest";

import { authHookToken, CallbackBaseUrlKey } from "#harness/authorization.js";
import { interactionSettled } from "#harness/interaction-facts.js";
import { transition } from "#harness/session-machine/commit.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import { applyEndingSignIns, ResumeSignInKey } from "./sign-in-callbacks.js";

const resumed: { token: string; params: unknown }[] = [];
const resume = vi.fn(
  async (
    token: string,
    payload: { payloads: { authorizationCallback: { callback: { params: unknown } } }[] },
  ) => {
    resumed.push({ token, params: payload.payloads[0]!.authorizationCallback.callback.params });
  },
);

const OWN = "https://v.example";

function signInRow(interactionId: string, asker?: string, waitsOn?: string): InteractionRow {
  const token = authHookToken(asker ?? "parent");
  return {
    interactionId,
    introducedAt: 0,
    startedAt: "1970-01-01T00:00:00.000Z",
    ...(asker !== undefined && { origin: { interactionId: `attempt-${asker}`, sessionId: asker } }),
    request: {
      kind: "sign-in",
      prompt: "Sign in to GitHub",
      signIn: {
        callbackUrl: `${OWN}${createEveConnectionCallbackRoutePath("github", `attempt-${asker ?? "parent"}`, token)}`,
        grant: "github/vercel-v",
        name: "github",
        ...(waitsOn !== undefined && { waitsOn }),
      },
    },
    status: "open",
    subject: { callId: `call-${interactionId}` },
  };
}

/** A parent whose own card `shown` has two children's sign-ins waiting on it. */
function parentStep() {
  const rows = [
    signInRow("shown"),
    signInRow("child-a-sign-in", "child-a", "shown"),
    signInRow("child-b-sign-in", "child-b", "shown"),
  ];
  const view = {
    ...emptySessionView(),
    interactions: Object.fromEntries(rows.map((row) => [row.interactionId, row])),
  };
  const apply = vi.fn(async () => {});
  return {
    apply,
    ctx: {
      get: (key: unknown) => (key === CallbackBaseUrlKey ? OWN : undefined),
      require: (key: unknown) => {
        if (key !== ResumeSignInKey) throw new Error("unexpected key");
        return resume;
      },
    },
    session: { sessionId: "parent" },
    view: () => ({ projection: { view } }),
  };
}

describe("applyEndingSignIns", () => {
  it("fails the children's sign-ins that wait on a card a newer attempt or a message ends", async () => {
    for (const [outcome, reason] of [
      ["abandoned", "Superseded by a newer authorization attempt."],
      ["withdrawn", "Cancelled because a new message arrived."],
    ] as const) {
      resumed.length = 0;
      const step = parentStep();
      const change = transition({
        events: [interactionSettled("shown", outcome, { reason })],
        turn: { remembered: {}, suspended: [] },
      });
      await applyEndingSignIns(step as never, change);
      expect(resumed, outcome).toEqual([
        { params: { error: reason }, token: authHookToken("child-a") },
        { params: { error: reason }, token: authHookToken("child-b") },
      ]);
      expect(step.apply).toHaveBeenCalledWith(change, undefined);
    }
  });

  it("leaves the waiting sign-ins to the answer when the card is accepted or declined", async () => {
    for (const outcome of ["accepted", "declined"] as const) {
      resumed.length = 0;
      const step = parentStep();
      await applyEndingSignIns(
        step as never,
        transition({
          events: [interactionSettled("shown", outcome)],
          turn: { remembered: {}, suspended: [] },
        }),
      );
      expect(resumed, outcome).toEqual([]);
    }
  });
});
