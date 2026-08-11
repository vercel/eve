import { Command } from "#compiled/commander/index.js";
import { describe, expect, it, vi } from "vitest";

import { registerRegistryCommands } from "./register-registry-commands.js";

const { runAddModelCommand } = vi.hoisted(() => ({
  runAddModelCommand: vi.fn(async () => {}),
}));

vi.mock("./model.js", () => ({ runAddModelCommand }));

describe("registerRegistryCommands", () => {
  it("routes model items to the built-in model command", async () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const program = new Command().exitOverride();
    registerRegistryCommands({ program, logger, appRoot: "/project" });

    await program.parseAsync(["node", "eve", "add", "model/openai/gpt-5.5"]);

    expect(runAddModelCommand).toHaveBeenCalledWith(logger, "/project", "openai/gpt-5.5");
  });
});
