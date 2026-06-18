import { describe, expect, it } from "vitest";

import { initAgentDevHandoff, initAgentInstructions } from "./agent-instructions.js";

describe("initAgentInstructions", () => {
  // This is the single home for the launching-agent instruction contract; the
  // init and scenario tiers assert control flow, not this prose.
  it("collects intent one question at a time and scaffolds with a universal command", () => {
    const instructions = initAgentInstructions();

    expect(instructions).toContain("questions one at a time");
    expect(instructions).toContain("What should the agent do?");
    expect(instructions).toContain("ask the user to confirm it");
    expect(instructions).toContain("Web Chat");
    expect(instructions).toContain("--channel-web-nextjs");
    // `npx` runs without a prior install and is package-manager agnostic, so the
    // guide hardcodes it rather than rendering a launcher-specific command.
    expect(instructions).toContain("npx eve@latest init <name>");
    expect(instructions).toContain("node_modules/eve/docs/");
    expect(instructions).toContain("npx eve dev --no-ui");
    expect(instructions).not.toContain("npm run dev");
    expect(instructions).not.toContain("starts the dev server");
  });

  it("routes both channels and connections through Vercel Connect", () => {
    const instructions = initAgentInstructions();

    // Channels: Slack credentials are provisioned by Connect, not hand-managed.
    expect(instructions).toContain("eve channels add slack");
    // Connections: per-user auth wires through Connect's eve helper.
    expect(instructions).toContain("agent/connections/");
    expect(instructions).toContain("@vercel/connect/eve");
    // Both surfaces name the product, so neither path is left to hand-rolled tokens.
    expect(instructions.match(/Vercel Connect/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("initAgentDevHandoff", () => {
  it("points at the bundled docs and gives the agent a headless verification command", () => {
    const handoff = initAgentDevHandoff({
      projectPath: "/tmp/triage-bot",
      devCommand: "npm exec -- eve dev",
    });

    expect(handoff).toContain("/tmp/triage-bot/node_modules/eve/docs/");
    expect(handoff).toContain("/tmp/triage-bot/agent/instructions.md");
    expect(handoff).toContain("purpose you collected");
    expect(handoff).toMatch(/controllable\s+background process/);
    expect(handoff).toContain("cd /tmp/triage-bot");
    expect(handoff).toContain("npm exec -- eve dev --no-ui");
    expect(handoff).toContain("Give the user the interactive command");
    expect(handoff).not.toContain("{{devCommand}}");
  });
});
