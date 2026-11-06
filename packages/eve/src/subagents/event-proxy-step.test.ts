import { describe, expect, it } from "vitest";

import { authHookToken } from "#harness/authorization.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import { localChildCallback } from "./event-proxy-step.js";

const OWN = "https://v.example";

function row(
  callbackUrl: string,
  sessionId = "child-a",
): Pick<InteractionRow, "origin" | "request"> {
  return {
    origin: { interactionId: "attempt-a", sessionId },
    request: {
      kind: "sign-in",
      prompt: "Sign in to GitHub",
      signIn: { callbackUrl, grant: "github/vercel-v", name: "github" },
    },
  };
}

function url(origin: string, token: string): string {
  return `${origin}${createEveConnectionCallbackRoutePath("github", "attempt-a", token)}`;
}

describe("localChildCallback", () => {
  it("reads the callback of a sign-in this deployment's own child asked", () => {
    expect(localChildCallback(row(url(OWN, authHookToken("child-a"))), OWN)).toEqual({
      attemptId: "attempt-a",
      name: "github",
      token: authHookToken("child-a"),
    });
  });

  it("never resumes a callback on another deployment, as a remote child's is", () => {
    expect(
      localChildCallback(row(url("https://remote.example", authHookToken("child-a"))), OWN),
    ).toBeUndefined();
  });

  it("never resumes a hook the URL names other than the asking child's inbox", () => {
    for (const token of [authHookToken("other-session"), "some-hook-token"])
      expect(localChildCallback(row(url(OWN, token)), OWN), token).toBeUndefined();
  });

  it("never resumes a callback URL it cannot read", () => {
    expect(localChildCallback(row("not a url"), OWN)).toBeUndefined();
    expect(localChildCallback(row(`${OWN}/somewhere/else`), OWN)).toBeUndefined();
  });
});
