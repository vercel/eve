import { describe, expect, it } from "vitest";

import type {
  InteractionOpenedData,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import { sameRelayedSignIn, waitingSignIn } from "./sign-ins.js";

const RUI = { id: "rui", issuer: "vercel", type: "user" } as const;

function signIn(overrides: Partial<SignInChallenge> = {}): SignInChallenge {
  return {
    callbackUrl: "https://v.example/eve/v1/connections/github/callback/attempt-1/token",
    grant: "github/vercel-v",
    name: "github",
    principal: RUI,
    ...overrides,
  };
}

describe("sameRelayedSignIn", () => {
  it("matches the same grant for the same principal from the same deployment", () => {
    expect(
      sameRelayedSignIn(
        signIn(),
        signIn({ callbackUrl: "https://v.example/eve/v1/connections/gh/callback/attempt-2/t" }),
      ),
    ).toBe(true);
  });

  it("never matches another principal's sign-in for the same grant", () => {
    for (const principal of [
      { ...RUI, id: "ben" },
      { ...RUI, issuer: "other" },
      { id: "rui", type: "app" },
      undefined,
    ])
      expect(sameRelayedSignIn(signIn(), signIn({ principal })), JSON.stringify(principal)).toBe(
        false,
      );
  });

  it("never matches across grants, or without one, even for the same connection name", () => {
    expect(sameRelayedSignIn(signIn(), signIn({ grant: "github/other" }))).toBe(false);
    expect(sameRelayedSignIn(signIn(), signIn({ grant: undefined }))).toBe(false);
    expect(sameRelayedSignIn(signIn({ grant: undefined }), signIn({ grant: undefined }))).toBe(
      false,
    );
  });

  it("never matches a sign-in minted by another deployment", () => {
    expect(sameRelayedSignIn(signIn(), signIn({ callbackUrl: "https://w.example/eve/v1/x" }))).toBe(
      false,
    );
    expect(sameRelayedSignIn(signIn(), signIn({ callbackUrl: undefined }))).toBe(false);
  });
});

function opened(
  interactionId: string,
  overrides: Partial<SignInChallenge> = {},
  subject: InteractionOpenedData["subject"] = { callId: `call-${interactionId}` },
): InteractionOpenedData {
  return {
    interactionId,
    request: { kind: "sign-in", prompt: "Sign in", signIn: signIn(overrides) },
    subject,
  };
}

function viewOf(
  ...rows: readonly (InteractionOpenedData & { readonly status?: InteractionRow["status"] })[]
): SessionView {
  const interactions = rows.map((row): InteractionRow => ({
    introducedAt: 0,
    startedAt: "1970-01-01T00:00:00.000Z",
    status: "open",
    ...row,
  }));
  return {
    ...emptySessionView(),
    interactions: Object.fromEntries(interactions.map((row) => [row.interactionId, row])),
  };
}

describe("waitingSignIn", () => {
  it("names the open sign-in the person already has a card for", () => {
    const view = viewOf(opened("shown"), opened("waiting", { waitsOn: "shown" }));
    expect(waitingSignIn(view, opened("next")).request.signIn?.waitsOn).toBe("shown");
  });

  it("leaves another principal's sign-in for the same grant with its own card", () => {
    const view = viewOf(opened("shown"));
    const ben = opened("ben", { principal: { ...RUI, id: "ben" } });
    expect(waitingSignIn(view, ben)).toBe(ben);
  });

  it("leaves a sign-in with its own card when the shown one closes or is closing", () => {
    const next = opened("next");
    expect(waitingSignIn(viewOf({ ...opened("shown"), status: "settled" }), next)).toBe(next);
    expect(waitingSignIn(viewOf(opened("shown")), next, new Set(["shown"]))).toBe(next);
  });

  it("never waits on or for a responder's sign-in, which its approval prompts for", () => {
    const responder = opened("responder", {}, { responseId: "response-1" });
    expect(waitingSignIn(viewOf(opened("shown")), responder)).toBe(responder);
    const next = opened("next");
    expect(waitingSignIn(viewOf(responder), next)).toBe(next);
  });
});
