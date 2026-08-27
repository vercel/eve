import { Command } from "#compiled/commander/index.js";
import { describe, expect, it, vi } from "vitest";

import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";

function context(): CliApplicationContext & { resolve: ReturnType<typeof vi.fn> } {
  return { root: "/workspace", resolve: vi.fn(async () => {}) };
}

describe("applicationCommand", () => {
  it("resolves the application root before running the action", async () => {
    const applicationContext = context();
    const action = vi.fn();
    const program = new Command().exitOverride();
    applicationCommand(program.command("build"), applicationContext).action(action);

    await program.parseAsync(["build"], { from: "user" });

    expect(applicationContext.resolve).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it("supports command-local conditional resolution", async () => {
    const applicationContext = context();
    const program = new Command().exitOverride();
    applicationCommand(
      program.command("invoke").option("--url <url>"),
      applicationContext,
      (command) => command.opts<{ url?: string }>().url === undefined,
    ).action(vi.fn());

    await program.parseAsync(["invoke", "--url", "https://example.com"], { from: "user" });

    expect(applicationContext.resolve).not.toHaveBeenCalled();
  });
});
