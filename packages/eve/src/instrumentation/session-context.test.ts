import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  ParentSessionKey,
} from "#context/keys.js";
import { readInstrumentationSessionContext } from "#instrumentation/session-context.js";

const initiator: SessionAuthContext = {
  attributes: { email: "private@example.com" },
  authenticator: "oidc",
  principalId: "initiator-secret",
  principalType: "user",
};

const current: SessionAuthContext = {
  attributes: {},
  authenticator: "api-key",
  principalId: "service-secret",
  principalType: "service",
};

describe("readInstrumentationSessionContext", () => {
  it("keeps the initiator stable while the current principal changes", () => {
    const context = new ContextContainer();
    context.set(AuthKey, current);
    context.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "public" },
    });
    context.set(InitiatorAuthKey, initiator);

    const first = readInstrumentationSessionContext(context);
    context.set(AuthKey, initiator);
    const continuation = readInstrumentationSessionContext(context);

    expect(first.principals.currentPrincipal).toEqual({
      id: "service-secret",
      type: "service",
    });
    expect(continuation.principals.currentPrincipal).toEqual(first.principals.initiatorPrincipal);
    expect(continuation.principals.initiatorPrincipal).toEqual(first.principals.initiatorPrincipal);
  });

  it("uses the actual principal ID across a public delegated trace tree", () => {
    const parent = new ContextContainer();
    parent.set(AuthKey, initiator);
    parent.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "public" },
    });
    parent.set(InitiatorAuthKey, initiator);

    const child = new ContextContainer();
    child.set(AuthKey, initiator);
    child.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "public" },
    });
    child.set(InitiatorAuthKey, initiator);
    child.set(ParentSessionKey, {
      callId: "call-1",
      rootSessionId: "root-session",
      sessionId: "parent-session",
      turn: { id: "turn-1", sequence: 0 },
    });

    const parentSummary = readInstrumentationSessionContext(parent).principals.currentPrincipal;
    const childSummary = readInstrumentationSessionContext(child).principals.currentPrincipal;

    expect(childSummary).toEqual(parentSummary);
    expect(childSummary).toEqual({ id: "initiator-secret", type: "user" });
    expect(JSON.stringify(childSummary)).not.toContain("private@example.com");
  });

  it("keeps private principal metadata type-only", () => {
    const context = new ContextContainer();
    context.set(AuthKey, current);
    context.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "private" },
    });
    context.set(InitiatorAuthKey, initiator);

    expect(readInstrumentationSessionContext(context).principals).toEqual({
      currentPrincipal: { type: "service" },
      initiatorPrincipal: { type: "user" },
    });
  });
});
