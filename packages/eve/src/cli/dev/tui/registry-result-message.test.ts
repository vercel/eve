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
      "3 additions: 2 added, 1 failed\n\n" +
        "  ✓ Web Chat\n" +
        "    Installed.\n\n" +
        "  ✓ Photon iMessage\n" +
        "    Agent phone number  +15551234567\n" +
        "    Configured MCP connection.\n\n" +
        "  ⨯ Slack\n" +
        "    Vercel CLI is not authenticated.\n" +
        "    Run /vc:login, then try again.",
    );
  });

  it("gives an all-failed report a meaningful headline", () => {
    expect(
      formatRegistrySessionResult({
        items: [],
        failures: [
          { title: "Web Chat", message: "Dependency installation failed." },
          { title: "Notion", message: "Vercel Connect setup failed." },
        ],
      }),
    ).toBe(
      "2 additions: 2 failed\n\n" +
        "  ⨯ Web Chat\n" +
        "    Dependency installation failed.\n\n" +
        "  ⨯ Notion\n" +
        "    Vercel Connect setup failed.",
    );
  });

  it("reports every installed, cancelled, and failed selection in order", () => {
    expect(
      formatRegistrySessionResult({
        items: [
          { title: "Web Chat", facts: [], output: [] },
          { title: "Notion", facts: [], output: [] },
        ],
        failures: [{ title: "GitHub", message: "Installation failed." }],
        outcomes: [
          { kind: "installed", title: "Web Chat", facts: [], output: [] },
          { kind: "cancelled", title: "Slack" },
          { kind: "failed", title: "GitHub", message: "Installation failed." },
          { kind: "installed", title: "Notion", facts: [], output: [] },
        ],
      }),
    ).toBe(
      "4 additions: 2 added, 1 failed, 1 cancelled\n\n" +
        "  ✓ Web Chat\n" +
        "    Installed.\n\n" +
        "  – Slack\n" +
        "    Cancelled.\n\n" +
        "  ⨯ GitHub\n" +
        "    Installation failed.\n\n" +
        "  ✓ Notion\n" +
        "    Installed.",
    );
  });
});
