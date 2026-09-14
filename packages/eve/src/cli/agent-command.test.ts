import { Command } from "#compiled/commander/index.js";
import { describe, expect, it, vi } from "vitest";

import { agentCommand } from "#cli/agent-command.js";
import type { CliApplicationContext } from "#cli/application-command.js";

function workspaceContext(): CliApplicationContext {
  const workspace = {
    root: "/repo",
    members: [
      { appRoot: "/repo/agents/research", name: "research" },
      { appRoot: "/repo/agents/support", name: "support" },
    ],
  };
  return {
    root: "/repo",
    resolve: vi.fn(async () => {}),
    resolveAgent: vi.fn(async () => ({
      environmentRoot: "/repo",
      kind: "workspace" as const,
      workspace,
    })),
  };
}

describe("agentCommand", () => {
  it("resolves an explicit workspace agent before the action", async () => {
    const context = workspaceContext();
    const action = vi.fn(() => expect(context.root).toBe("/repo/agents/support"));
    const program = new Command().exitOverride();
    agentCommand(program.command("info"), context).action(action);

    await program.parseAsync(["info", "--agent", "support"], { from: "user" });

    expect(action).toHaveBeenCalledOnce();
  });

  it("reports available agents for an unknown name", async () => {
    const context = workspaceContext();
    const program = new Command().exitOverride();
    agentCommand(program.command("info"), context).action(vi.fn());

    await expect(
      program.parseAsync(["info", "--agent", "missing"], { from: "user" }),
    ).rejects.toThrow('Unknown agent "missing". Available agents: research, support.');
  });

  it("requires --agent for a multi-agent workspace without a TTY", async () => {
    const context = workspaceContext();
    const program = new Command().exitOverride();
    agentCommand(program.command("info"), context).action(vi.fn());

    await expect(program.parseAsync(["info"], { from: "user" })).rejects.toThrow(
      "Pass --agent <name>. Available agents: research, support.",
    );
  });

  it("automatically selects the only workspace agent", async () => {
    const context = workspaceContext();
    context.resolveAgent = vi.fn(async () => ({
      environmentRoot: "/repo",
      kind: "workspace" as const,
      workspace: {
        root: "/repo",
        members: [{ appRoot: "/repo/agents/support", name: "support" }],
      },
    }));
    const action = vi.fn(() => expect(context.root).toBe("/repo/agents/support"));
    const program = new Command().exitOverride();
    agentCommand(program.command("info"), context).action(action);

    await program.parseAsync(["info"], { from: "user" });

    expect(action).toHaveBeenCalledOnce();
  });
});
