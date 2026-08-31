import { describe, expect, it } from "vitest";

import { formatRegistrySessionResult } from "./registry-result-message.js";

describe("formatRegistrySessionResult", () => {
  it("keeps installed-item facts and skipped installation errors after setup closes", () => {
    expect(
      formatRegistrySessionResult({
        items: [
          {
            address: "channel/photon-imessage",
            title: "Photon iMessage",
            facts: [{ label: "Agent phone number", value: "+15551234567", kind: "phone" }],
            output: [],
          },
        ],
        failures: [
          {
            address: "channel/slack",
            title: "Slack",
            message: "Vercel CLI is not authenticated.",
            detail: "Vercel CLI is not authenticated.\nError: session missing",
          },
        ],
      }),
    ).toBe(
      "Added Photon iMessage\n\n" +
        "Photon iMessage\n" +
        "  Agent phone number  +15551234567\n\n" +
        "Couldn't add Slack\n" +
        "  Vercel CLI is not authenticated.\n" +
        "  Vercel CLI is not authenticated.\nError: session missing",
    );
  });
});
