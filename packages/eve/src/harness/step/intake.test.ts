import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ParentSessionKey, SenderAuthKey } from "#context/keys.js";
import type { Step } from "#harness/step/context.js";
import { prepareTurnInput, settleRuntimeWork } from "#harness/step/intake.js";
import type { HarnessSession, HarnessStepInput } from "#harness/types.js";

describe("settleRuntimeWork", () => {
  it("records what a call's agent spent after nothing waits on the call any more", async () => {
    const publish = vi.fn(async () => {});
    // The step only publishes on this path: nothing waits on the session's calls.
    const session = { state: undefined } as Partial<HarnessSession> as HarnessSession;
    const step = { publish, session } as Partial<Step> as Step;
    const spent = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 90, outputTokens: 9 };
    const input = {
      delegatedUsage: { "call-1": spent },
      message: "Next?",
    } as HarnessStepInput;

    const settled = await settleRuntimeWork(step, input);

    expect(publish).toHaveBeenCalledWith([
      { data: { kind: "delegated-late", usage: spent }, type: "usage.recorded" },
    ]);
    expect(settled).toEqual({ input: { message: "Next?" }, waited: false });
  });
});

describe("prepareTurnInput", () => {
  const person = (principalId: string): SessionAuthContext => ({
    attributes: {},
    authenticator: "test",
    principalId,
    principalType: "user",
  });
  const alice = person("alice");
  const bob = person("bob");

  // Who spoke last ends the standing approvals of anyone else, so a delegated session, whose
  // messages come from the agent that called it, still names the delegating turn's sender.
  it.each([
    { label: "a person's own session", delegated: false, sender: bob },
    {
      label: "a delegated session, which reads no sender line",
      delegated: true,
      sender: undefined,
    },
  ])("names who spoke last in $label", async ({ delegated, sender }) => {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, alice);
    ctx.set(SenderAuthKey, bob);
    if (delegated) ctx.set(ParentSessionKey, { sessionId: "parent" } as never);
    const step = {
      ctx,
      position: () => ({ sequence: 0, turnId: "turn_0" }) as never,
      session: { state: undefined } as never,
      view: () => ({ projection: { view: { deliveries: {} } } }) as never,
    } as Partial<Step> as Step;

    const turn = await prepareTurnInput(step, { message: "Use staging." } as HarnessStepInput, {
      consumedMessage: false,
    });

    expect(turn.spokeLast).toEqual(bob);
    expect(turn.sender).toEqual(sender);
  });
});
