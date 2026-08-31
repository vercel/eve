import { describe, expect, it } from "vitest";

import { formatRegistrySessionResult } from "./registry-result-message.js";

describe("formatRegistrySessionResult", () => {
  it("formats installed items and multiline failures in one report", () => {
    expect(
      formatRegistrySessionResult({
        items: [
          { title: "Web Chat", facts: [], output: [] },
          {
            title: "Photon iMessage",
            facts: [{ label: "Agent phone number", value: "+15551234567", kind: "phone" }],
            output: ["Configured MCP connection."],
          },
        ],
        failures: [
          {
            title: "Slack",
            message: "Vercel CLI is not authenticated.\nRun /vc:login, then try again.",
          },
        ],
      }),
    ).toBe(
      "Added Web Chat and Photon iMessage\n\n" +
        "Web Chat\n" +
        "  Installed.\n\n" +
        "Photon iMessage\n" +
        "  Agent phone number  +15551234567\n" +
        "  Configured MCP connection.\n\n" +
        "Couldn't add Slack\n" +
        "  Vercel CLI is not authenticated.\n" +
        "  Run /vc:login, then try again.",
    );
  });
});
