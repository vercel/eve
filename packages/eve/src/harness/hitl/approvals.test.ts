import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#context/session-auth.js";
import { endCallerApprovals } from "#harness/hitl/approvals.js";
import type { ApprovalAsk, SessionView, SuspendedStep } from "#harness/session-machine/view.js";

const person = (principalId: string): SessionAuthContext => ({
  attributes: {},
  authenticator: "test",
  principalId,
  principalType: "user",
});
const alice = person("alice");
const carol = person("carol");
const callerApproval = (caller: SessionAuthContext) =>
  JSON.stringify(["eve.callerApproval", principalOf(caller)]);
const toolOnce = JSON.stringify(["deploy", "once"]);

/** A session that remembers Alice's and Carol's caller approvals and a tool's `once()`. */
function view(requests: readonly ApprovalAsk[] = []): SessionView {
  const accepted = { interactionId: "earlier", outcome: "accepted" as const };
  const step = { requests } as Partial<SuspendedStep> as SuspendedStep;
  return {
    turn: {
      remembered: {
        [callerApproval(alice)]: accepted,
        [callerApproval(carol)]: accepted,
        [toolOnce]: accepted,
      },
      suspended: [step],
    },
  } as Partial<SessionView> as SessionView;
}

function ask(interactionId: string, caller: SessionAuthContext): ApprovalAsk {
  return {
    call: { callId: interactionId, input: {}, toolName: "use_token" },
    interactionId,
    remember: { key: callerApproval(caller) },
    request: { kind: "approval" } as ApprovalAsk["request"],
  };
}

describe("endCallerApprovals", () => {
  it("keeps the sender's own approval and a tool's once(), and ends every other caller's", () => {
    const { turn } = endCallerApprovals(view(), alice);

    expect(Object.keys(turn.remembered)).toEqual([callerApproval(alice), toolOnce]);
  });

  it("ends every caller approval after someone who isn't signed in speaks", () => {
    const { turn } = endCallerApprovals(view(), null);

    expect(Object.keys(turn.remembered)).toEqual([toolOnce]);
  });

  it("stops an open request for another caller's identity from being remembered", () => {
    const { turn } = endCallerApprovals(view([ask("own", alice), ask("other", carol)]), alice);

    expect(turn.suspended[0]?.requests.map((request) => request.remember)).toEqual([
      { key: callerApproval(alice) },
      undefined,
    ]);
  });
});
