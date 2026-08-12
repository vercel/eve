import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/twilio/defaults.js";
import type { TwilioEventContext } from "#public/channels/twilio/twilioChannel.js";

describe("Twilio connection authorization defaults", () => {
  it("sends challenges and outcomes to the bound phone number", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const partialTwilio: Partial<TwilioEventContext["twilio"]> = { sendMessage };
    const partialChannel: Pick<TwilioEventContext, "twilio"> = {
      twilio: partialTwilio as TwilioEventContext["twilio"],
    };
    const channel = partialChannel as TwilioEventContext;
    const ctx = {} as SessionContext;

    await defaultEvents["authorization.required"]!(
      {
        authorization: { url: "https://connect.example.com/auth", userCode: "ABCD-1234" },
        description: "Connect your account to continue.",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      ctx,
    );
    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      ctx,
    );

    expect(sendMessage.mock.calls[0]?.[0]).toContain("https://connect.example.com/auth");
    expect(sendMessage.mock.calls[1]?.[0]).toBe("Notion connected. Resuming.");
  });
});
