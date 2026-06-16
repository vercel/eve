import { describe, expect, it } from "vitest";

import { initAgentDevHandoff, initAgentInstructions } from "./agent-instructions.js";

describe("initAgentInstructions", () => {
  // This is the single home for the launching-agent instruction contract; the
  // init and scenario tiers assert control flow, not this prose.
  it("tells the agent to collect intent one question at a time and reruns under the launcher", () => {
    const instructions = initAgentInstructions({ initCommand: "pnpm dlx eve init" });

    expect(instructions).toContain("questions one at a time");
    expect(instructions).toContain("What should the agent do?");
    expect(instructions).toContain("ask the user to confirm it");
    expect(instructions).toContain("Web Chat");
    expect(instructions).toContain("--channel-web-nextjs");
    expect(instructions).toContain("pnpm dlx eve init <target>");
    // A direct binary run carries no launcher prefix.
    expect(initAgentInstructions({ initCommand: "eve init" })).toContain("eve init <target>");
  });
});

describe("initAgentDevHandoff", () => {
  it("points at the bundled docs, applies the purpose, and hands the dev command to the user", () => {
    const handoff = initAgentDevHandoff({
      projectPath: "/tmp/triage-bot",
      devCommand: "npm exec -- eve dev",
    });

    expect(handoff).toContain("/tmp/triage-bot/node_modules/eve/docs/");
    expect(handoff).toContain("/tmp/triage-bot/agent/instructions.md");
    expect(handoff).toContain("purpose you collected");
    expect(handoff).toContain("Do not start `eve dev` because it is interactive");
    expect(handoff).toContain("cd /tmp/triage-bot");
    expect(handoff).toContain("npm exec -- eve dev");
  });
});
