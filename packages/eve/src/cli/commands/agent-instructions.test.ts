import { describe, expect, it } from "vitest";

import {
  initAgentDevHandoff,
  initAgentInstructions,
  initAgentReplPrompt,
} from "./agent-instructions.js";

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
    // pre-scaffold guide renders the universal `npx eve dev` through the shared
    // prompt renderer rather than a launcher-specific command.
    expect(instructions).toContain("npx eve@latest init <name>");
    expect(instructions).toContain("node_modules/eve/docs/");
    expect(instructions).toContain("npx eve dev --no-ui");
    expect(instructions).not.toContain("npm run dev");
    expect(instructions).not.toContain("starts the dev server");
    // The shared renderer resolves every placeholder, even in the pre-scaffold guide.
    expect(instructions).not.toContain("{{");
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
  it("guides the user and distinguishes the agent REPL from headless verification", () => {
    const handoff = initAgentDevHandoff({
      projectPath: "/tmp/triage-bot",
      devCommand: "npm exec -- eve dev",
    });

    expect(handoff).toContain("/tmp/triage-bot/node_modules/eve/docs/");
    expect(handoff).toContain("/tmp/triage-bot/agent/instructions.md");
    expect(handoff).toContain("What should the agent do?");
    expect(handoff).toContain("Vercel Connect");
    expect(handoff).toContain("HMR development server");
    expect(handoff).toContain("does not start or control this coding-agent session");
    expect(handoff).toMatch(/controllable\s+background process/);
    expect(handoff).toContain("cd /tmp/triage-bot");
    expect(handoff).toContain("npm exec -- eve dev --no-ui");
    expect(handoff).toContain("Give the user the interactive command");
    expect(handoff).not.toContain("{{devCommand}}");
  });
});

describe("initAgentReplPrompt", () => {
  it("uses the shared guidance without interpolating the project path into the launch argument", () => {
    const prompt = initAgentReplPrompt({ devCommand: "pnpm exec eve dev" });

    expect(prompt).toContain("The project at `.` is already scaffolded.");
    expect(prompt).toContain("What should the agent do?");
    expect(prompt).toContain("pnpm exec eve dev --no-ui");
    expect(prompt).not.toContain("{{");
  });
});
