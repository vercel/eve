import { Command } from "#compiled/commander/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  parseConnectPrincipalType,
  registerIntegrationCommands,
} from "./register-integration-commands.js";

describe("parseConnectPrincipalType", () => {
  it.each(["app", "user"] as const)("accepts %s", (principalType) => {
    expect(parseConnectPrincipalType(principalType)).toBe(principalType);
  });

  it("rejects unsupported principal types", () => {
    expect(() => parseConnectPrincipalType("jwt-bearer")).toThrow(
      'Expected principal type "app" or "user".',
    );
  });

  it("documents setup while keeping the registry-only connect command hidden", () => {
    const program = new Command();
    registerIntegrationCommands({
      program,
      logger: { error: vi.fn(), log: vi.fn() },
      applicationContext: { root: "/workspace", resolve: vi.fn(async () => {}) },
    });

    expect(program.helpInformation()).toContain("integration");
    const integration = program.commands.find((command) => command.name() === "integration");
    expect(integration?.helpInformation()).toContain("setup [options] <kind>");
    expect(integration?.helpInformation()).not.toContain("connect <slug>");
  });
});
