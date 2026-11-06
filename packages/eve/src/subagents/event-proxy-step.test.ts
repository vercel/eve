import { describe, expect, it } from "vitest";

import { authHookToken } from "#harness/authorization.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { localSignInCallback, ownCallbacks } from "#harness/hitl/sign-in-callbacks.js";
import { signInsAnswered, signInsEnded } from "./event-proxy-step.js";

const OWN = "https://v.example";
const PARENT = { origin: OWN, sessionId: "parent" };

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

describe("localSignInCallback", () => {
  it("reads the callback of a sign-in this deployment's own child asked", () => {
    expect(localSignInCallback(row(url(OWN, authHookToken("child-a"))), PARENT)).toEqual({
      attemptId: "attempt-a",
      name: "github",
      token: authHookToken("child-a"),
    });
  });

  it("never resumes a callback on another deployment, as a remote child's is", () => {
    expect(
      localSignInCallback(row(url("https://remote.example", authHookToken("child-a"))), PARENT),
    ).toBeUndefined();
  });

  it("never resumes a hook the URL names other than the asking child's inbox", () => {
    for (const token of [authHookToken("other-session"), "some-hook-token"])
      expect(localSignInCallback(row(url(OWN, token)), PARENT), token).toBeUndefined();
  });

  it("never resumes a callback URL it cannot read", () => {
    expect(localSignInCallback(row("not a url"), PARENT)).toBeUndefined();
    expect(localSignInCallback(row(`${OWN}/somewhere/else`), PARENT)).toBeUndefined();
    for (const path of [
      "/eve/v1/connections/%ZZ/callback/attempt-a/token",
      "/eve/v1/connections/github/callback/%ZZ/token",
      `/eve/v1/connections/github/callback/attempt-a/%ZZ${authHookToken("child-a")}`,
    ])
      expect(localSignInCallback(row(`${OWN}${path}`), PARENT), path).toBeUndefined();
  });
});

describe("localSignInCallback for this session's own sign-in", () => {
  it("reads the callback of a sign-in this session asked itself", () => {
    const own = { ...row(url(OWN, authHookToken("parent"))), origin: undefined };
    expect(localSignInCallback(own, PARENT)?.token).toBe(authHookToken("parent"));
  });

  it("never resumes another session's hook from a row this session asked", () => {
    const own = { ...row(url(OWN, authHookToken("child-a"))), origin: undefined };
    expect(localSignInCallback(own, PARENT)).toBeUndefined();
  });
});

describe("ownCallbacks", () => {
  it("names a loopback dev server localhost, as Connect's callback URLs do", () => {
    const own = ownCallbacks("parent", "http://127.0.0.1:3000");
    const local = row(url("http://localhost:3000", authHookToken("child-a")));
    expect(localSignInCallback(local, own)?.token).toBe(authHookToken("child-a"));
  });

  it("keeps a deployment's own origin as it is", () => {
    expect(ownCallbacks("parent", "https://v.example/agents/v").origin).toBe(OWN);
  });
});

describe("signInsAnswered", () => {
  const ALICE = { id: "alice", issuer: "idp", type: "user" };
  const BOB = { id: "bob", issuer: "idp", type: "user" };

  function signInRow(
    interactionId: string,
    asker: string | undefined,
    principal: typeof ALICE,
    subject: InteractionRow["subject"] = { callId: `call-${interactionId}` },
  ): InteractionRow {
    return {
      interactionId,
      introducedAt: 0,
      startedAt: "1970-01-01T00:00:00.000Z",
      ...(asker !== undefined && { origin: { interactionId, sessionId: asker } }),
      request: {
        kind: "sign-in",
        prompt: "Sign in to GitHub",
        signIn: {
          callbackUrl: url(OWN, authHookToken(asker ?? "parent")),
          grant: "github/vercel-v",
          name: "github",
          principal,
        },
      },
      status: "open",
      subject,
    };
  }

  function tables(rows: readonly InteractionRow[]): SessionView {
    return {
      interactions: Object.fromEntries(rows.map((r) => [r.interactionId, r])),
    } as Partial<SessionView> as SessionView;
  }

  function answer(answered: InteractionRow, outcome: "accepted" | "declined" = "accepted") {
    return { interactionId: answered.interactionId, outcome, signIn: answered.request.signIn! };
  }

  it("settles every child's sign-in when this session's own is answered", () => {
    const parent = signInRow("parent-sign-in", undefined, ALICE);
    const view = tables([
      parent,
      signInRow("child-a-sign-in", "child-a", ALICE),
      signInRow("child-b-sign-in", "child-b", ALICE),
    ]);
    expect(signInsAnswered(view, answer(parent), PARENT).map((s) => s.callback.token)).toEqual([
      authHookToken("child-a"),
      authHookToken("child-b"),
    ]);
  });

  it("settles this session's own sign-in when a child's is answered", () => {
    const child = signInRow("child-a-sign-in", "child-a", ALICE);
    const view = tables([signInRow("parent-sign-in", undefined, ALICE), child]);
    expect(signInsAnswered(view, answer(child), PARENT)).toEqual([
      {
        callback: { attemptId: "attempt-a", name: "github", token: authHookToken("parent") },
        params: {},
      },
    ]);
  });

  it("passes a decline on as the provider's access_denied", () => {
    const parent = signInRow("parent-sign-in", undefined, ALICE);
    const view = tables([parent, signInRow("child-a-sign-in", "child-a", ALICE)]);
    expect(signInsAnswered(view, answer(parent, "declined"), PARENT)[0]?.params).toEqual({
      error: "access_denied",
    });
  });

  it("never settles another principal's sign-in, in either direction", () => {
    const parent = signInRow("parent-sign-in", undefined, ALICE);
    const bobs = signInRow("child-a-sign-in", "child-a", BOB);
    const view = tables([parent, bobs]);
    expect(signInsAnswered(view, answer(parent), PARENT)).toEqual([]);
    expect(signInsAnswered(view, answer(bobs), PARENT)).toEqual([]);
  });

  it("fails only the sign-ins that waited on a card that ended without an answer", () => {
    const shown = signInRow("child-a-sign-in", "child-a", ALICE);
    const waiting = (interactionId: string, asker: string | undefined): InteractionRow => {
      const r = signInRow(interactionId, asker, ALICE);
      return {
        ...r,
        request: { ...r.request, signIn: { ...r.request.signIn!, waitsOn: shown.interactionId } },
      };
    };
    const view = tables([
      shown,
      waiting("child-b-sign-in", "child-b"),
      waiting("parent-sign-in", undefined),
      // Its own card is shown, so its own answer settles it.
      signInRow("child-c-sign-in", "child-c", ALICE),
    ]);
    const ending = { interactionId: shown.interactionId, reason: "server_error" };
    expect(signInsEnded(view, ending, PARENT)).toEqual([
      {
        callback: { attemptId: "attempt-a", name: "github", token: authHookToken("child-b") },
        params: { error: "server_error" },
      },
      {
        callback: { attemptId: "attempt-a", name: "github", token: authHookToken("parent") },
        params: { error: "server_error" },
      },
    ]);
  });

  it("never settles a responder's sign-in, which settles through its own approval", () => {
    const child = signInRow("child-a-sign-in", "child-a", ALICE);
    const responder = signInRow("responder-sign-in", undefined, ALICE, { responseId: "r1" });
    expect(signInsAnswered(tables([child, responder]), answer(child), PARENT)).toEqual([]);
  });
});
