import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  runAddCommand,
  runRegistryAddCommand,
  runRegistryListCommand,
  runRegistrySearchCommand,
  resolveOfficialRegistryUrl,
  runRegistryViewCommand,
  type RegistryCommandLogger,
} from "./registry.js";

const {
  addRegistryItems,
  applyPackageManagerWorkspaceConfiguration,
  getRegistryItems,
  isEveProject,
  readFile,
  resolveInstalledPackageInfo,
  searchRegistries,
  writeFile,
} = vi.hoisted(() => ({
  addRegistryItems: vi.fn(),
  applyPackageManagerWorkspaceConfiguration: vi.fn(),
  getRegistryItems: vi.fn(),
  isEveProject: vi.fn(),
  readFile: vi.fn(),
  resolveInstalledPackageInfo: vi.fn(() => ({ name: "eve", version: "0.27.8" })),
  searchRegistries: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("#compiled/shadcn-registry/index.js", () => ({
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
}));

vi.mock("#setup/scaffold/index.js", () => ({ isEveProject }));
vi.mock("#setup/scaffold/workspace-root.js", () => ({ applyPackageManagerWorkspaceConfiguration }));
vi.mock("#internal/application/package.js", () => ({ resolveInstalledPackageInfo }));
vi.mock("node:fs/promises", () => ({ readFile, writeFile }));

function createLogger(): RegistryCommandLogger & { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
  };
}

describe("registry commands", () => {
  beforeEach(() => {
    delete process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
    vi.clearAllMocks();
    isEveProject.mockResolvedValue(true);
    readFile.mockResolvedValue(
      JSON.stringify({
        name: "project",
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );
  });

  afterEach(() => {
    delete process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
    process.exitCode = undefined;
  });

  it("normalizes the explicit development official-registry override", () => {
    expect(resolveOfficialRegistryUrl("http://localhost:4173/r/")).toBe("http://localhost:4173/r");
  });

  it.each([
    ["invalid URL", "not a URL"],
    ["unsupported protocol", "file:///tmp/registry"],
    ["credentials", "https://user:password@example.com/r"],
    ["query", "https://example.com/r?token=secret"],
    ["fragment", "https://example.com/r#preview"],
  ])("rejects a development official-registry override with %s", (_reason, value) => {
    expect(() => resolveOfficialRegistryUrl(value)).toThrow(/EVE_DEV_OFFICIAL_REGISTRY_URL/);
  });

  it("installs official items through the registry SDK", async () => {
    const logger = createLogger();
    getRegistryItems.mockResolvedValue([{ name: "extension/browser", type: "registry:item" }]);

    await runAddCommand(logger, "/project", "extension/browser", {
      overwrite: true,
    });

    expect(getRegistryItems).toHaveBeenCalledWith(["https://eve.dev/r/extension/browser.json"], {
      config: {
        registries: { "@acme": "https://example.com/r/{name}.json" },
      },
    });
    expect(addRegistryItems).toHaveBeenCalledWith(["https://eve.dev/r/extension/browser.json"], {
      config: {
        registries: { "@acme": "https://example.com/r/{name}.json" },
      },
      cwd: "/project",
      overwrite: true,
      silent: undefined,
    });
    expect(logger.errors).toEqual([]);
  });

  it.each(["web", "slack"] as const)(
    "installs the official %s item before running its declared setup",
    async (kind) => {
      const logger = createLogger();
      const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
      getRegistryItems.mockResolvedValue([
        {
          name: `channel/${kind}`,
          type: "registry:item",
          meta: {
            eve: {
              setup: { package: "eve", bin: "eve", args: ["integration", "setup", kind] },
            },
          },
        },
      ]);

      await runAddCommand(
        logger,
        "/project",
        `channel/${kind}`,
        { overwrite: true, yes: true },
        {
          loadSetupCommandRunner: async () => runSetupCommand,
        },
      );

      expect(addRegistryItems).toHaveBeenCalledOnce();
      expect(addRegistryItems.mock.invocationCallOrder[0]).toBeLessThan(
        runSetupCommand.mock.invocationCallOrder[0]!,
      );
      expect(runSetupCommand).toHaveBeenCalledWith(
        "/project",
        {
          package: "eve",
          bin: "eve",
          args: ["integration", "setup", kind, "--yes"],
        },
        `channel/${kind}`,
        expect.objectContaining({ prompter: expect.any(Object) }),
      );
    },
  );

  it("skips setup in non-interactive use and prints the resume command", async () => {
    const logger = createLogger();
    const runSetup = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([
      {
        meta: { eve: { setup: { package: "@acme/slack", bin: "eve-slack", args: ["setup"] } } },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "channel/slack",
      {},
      {
        isInteractive: () => false,
        loadSetupCommandRunner: async () => runSetup,
      },
    );

    expect(runSetup).not.toHaveBeenCalled();
    expect(logger.logs).toEqual([
      "Setup skipped. Run `eve add channel/slack --skip-install` when you're ready.",
    ]);
  });

  it("asks before setup and prints the resume command when declined", async () => {
    const logger = createLogger();
    const runSetup = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    const fake = createFakePrompter({ single: () => "no" });
    getRegistryItems.mockResolvedValue([
      {
        meta: { eve: { setup: { package: "@acme/slack", bin: "eve-slack", args: ["setup"] } } },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "channel/slack",
      {},
      {
        createPrompter: () => fake.prompter,
        isInteractive: () => true,
        loadSetupCommandRunner: async () => runSetup,
      },
    );

    expect(fake.selectMessages).toEqual(["Set up channel/slack now?"]);
    expect(runSetup).not.toHaveBeenCalled();
    expect(logger.logs).toEqual([
      "Setup skipped. Run `eve add channel/slack --skip-install` when you're ready.",
    ]);
  });

  it("prints the resume command when the setup CLI cancels", async () => {
    const logger = createLogger();
    const runSetup = vi.fn(async () => ({ kind: "cancelled" as const }));
    getRegistryItems.mockResolvedValue([
      {
        meta: { eve: { setup: { package: "@acme/slack", bin: "eve-slack", args: ["setup"] } } },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "channel/slack",
      { yes: true },
      {
        loadSetupCommandRunner: async () => runSetup,
      },
    );

    expect(logger.logs).toEqual([
      "Setup cancelled. Run `eve add channel/slack --skip-install` when you're ready.",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("runs setup directly without installing the item", async () => {
    const logger = createLogger();
    const runSetup = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([
      {
        meta: { eve: { setup: { package: "@acme/slack", bin: "eve-slack", args: ["setup"] } } },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "channel/slack",
      { skipInstall: true, yes: true },
      {
        loadSetupCommandRunner: async () => runSetup,
      },
    );

    expect(addRegistryItems).not.toHaveBeenCalled();
    expect(runSetup).toHaveBeenCalledWith(
      "/project",
      { package: "@acme/slack", bin: "eve-slack", args: ["setup", "--yes"] },
      "channel/slack",
      expect.objectContaining({ prompter: expect.any(Object) }),
    );
  });

  it("rejects --overwrite with --skip-install", async () => {
    const logger = createLogger();

    await runAddCommand(logger, "/project", "channel/slack", {
      skipInstall: true,
      overwrite: true,
    });

    expect(logger.errors).toEqual(["--overwrite cannot be used with --skip-install."]);
    expect(getRegistryItems).not.toHaveBeenCalled();
    expect(addRegistryItems).not.toHaveBeenCalled();
  });

  it("rejects --skip-setup with --skip-install", async () => {
    const logger = createLogger();

    await runAddCommand(logger, "/project", "channel/slack", {
      skipInstall: true,
      skipSetup: true,
    });

    expect(logger.errors).toEqual(["--skip-install cannot be used with --skip-setup."]);
    expect(getRegistryItems).not.toHaveBeenCalled();
    expect(addRegistryItems).not.toHaveBeenCalled();
  });

  it("rejects setup for third-party items", async () => {
    const logger = createLogger();

    await runAddCommand(
      logger,
      "/project",
      "@acme/slack",
      { skipInstall: true },
      {
        loadSetupCommandRunner: vi.fn(),
      },
    );

    expect(logger.errors).toEqual([
      "Setup flows are currently supported only for official eve registry items.",
    ]);
    expect(getRegistryItems).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not infer setup from the item address", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([{ name: "channel/web", type: "registry:item" }]);

    await runAddCommand(
      logger,
      "/project",
      "channel/web",
      {},
      {
        loadSetupCommandRunner: async () => runSetupCommand,
      },
    );

    expect(runSetupCommand).not.toHaveBeenCalled();
    expect(addRegistryItems).toHaveBeenCalledOnce();
  });

  it("does not execute setup metadata from a URL item", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([
      {
        name: "channel/web",
        type: "registry:item",
        meta: {
          eve: {
            setup: { package: "eve", bin: "eve", args: ["integration", "setup", "web"] },
          },
        },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "https://example.com/channel/web.json",
      {},
      {
        loadSetupCommandRunner: async () => runSetupCommand,
      },
    );

    expect(runSetupCommand).not.toHaveBeenCalled();
    expect(addRegistryItems).toHaveBeenCalledOnce();
    expect(applyPackageManagerWorkspaceConfiguration).not.toHaveBeenCalled();
  });

  it("accepts any declared package binary from trusted official metadata", async () => {
    const logger = createLogger();
    getRegistryItems.mockResolvedValue([
      {
        name: "channel/unknown",
        type: "registry:item",
        meta: {
          eve: {
            setup: { package: "shell-package", bin: "sh", args: ["-c", "echo nope"] },
          },
        },
      },
    ]);

    await runAddCommand(logger, "/project", "channel/unknown", { skipSetup: true });

    expect(logger.errors).toEqual([]);
    expect(addRegistryItems).toHaveBeenCalledOnce();
  });

  it("rejects an item that requires a newer eve before installation", async () => {
    const logger = createLogger();
    getRegistryItems.mockResolvedValue([
      {
        name: "channel/photon",
        type: "registry:item",
        meta: {
          eve: {
            requires: ">=0.30.0",
            setup: { package: "eve", bin: "eve", args: ["integration", "setup", "web"] },
          },
        },
      },
    ]);

    await runAddCommand(logger, "/project", "channel/photon", {});

    expect(logger.errors).toEqual([
      "This registry item requires eve >=0.30.0, but this project is using eve 0.27.8. Upgrade eve and run the command again.",
    ]);
    expect(addRegistryItems).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("adds namespace mappings to package.json", async () => {
    const logger = createLogger();

    await runRegistryAddCommand(logger, "/project", ["@other=https://other.example/r/{name}.json"]);

    expect(writeFile).toHaveBeenCalledWith(
      "/project/package.json",
      `${JSON.stringify(
        {
          name: "project",
          registries: {
            "@acme": "https://example.com/r/{name}.json",
            "@other": "https://other.example/r/{name}.json",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(logger.logs).toContain("Added @other to package.json.");
  });

  it("lists the official registry without configured namespaces", async () => {
    const logger = createLogger();
    readFile.mockResolvedValue(JSON.stringify({ name: "project" }));
    searchRegistries.mockResolvedValue({
      items: [],
      pagination: { total: 0, offset: 0, limit: 0, hasMore: false },
    });

    await runRegistryListCommand(logger, "/project");

    expect(searchRegistries).toHaveBeenCalledWith(["https://eve.dev/r/registry.json"], {
      config: { registries: {} },
      continueOnError: false,
      query: undefined,
    });
    expect(logger.logs).toEqual(["No registry items found."]);
  });

  it("preserves explicit registry URLs in list output", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "https://example.com/r/registry.json",
          name: "search",
          addCommandArgument: "https://example.com/r/search.json",
          description: "External search tools",
        },
      ],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    });

    await runRegistryListCommand(logger, "/project", "https://example.com/r/registry.json");

    expect(logger.logs).toEqual([
      "Found 1 item in 1 registry",
      "",
      "https://example.com/r/search.json — External search tools",
    ]);
  });

  it("searches the official catalog and configured registries", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "https://eve.dev/r/registry.json",
          name: "extension/agent-browser",
          addCommandArgument: "https://eve.dev/r/extension/agent-browser.json",
          description: "Browser automation",
        },
        {
          registry: "@acme",
          name: "browser",
          addCommandArgument: "@acme/browser",
          description: "Browser tools",
        },
      ],
      pagination: { total: 2, offset: 0, limit: 2, hasMore: false },
    });

    await runRegistrySearchCommand(logger, "/project", "browser");

    expect(searchRegistries).toHaveBeenCalledWith(["https://eve.dev/r/registry.json", "@acme"], {
      config: {
        registries: { "@acme": "https://example.com/r/{name}.json" },
      },
      continueOnError: true,
      query: "browser",
    });
    expect(logger.logs).toEqual([
      'Found 2 items matching "browser" in 2 registries',
      "",
      "extension/agent-browser",
      "@acme/browser",
    ]);
  });

  it("reports total registry failure without describing it as an empty result", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [],
      errors: [
        { registry: "https://eve.dev/r/registry.json", message: "eve unavailable" },
        { registry: "@acme", message: "acme unavailable" },
      ],
      pagination: { total: 0, offset: 0, limit: 0, hasMore: false },
    });

    await runRegistrySearchCommand(logger, "/project", "browser");

    expect(logger.logs).toEqual([]);
    expect(logger.errors).toEqual([
      "https://eve.dev/r/registry.json: eve unavailable",
      "@acme: acme unavailable",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a registry item as JSON", async () => {
    const logger = createLogger();
    getRegistryItems.mockResolvedValue([{ name: "browser", type: "registry:item" }]);

    await runRegistryViewCommand(logger, "/project", "extension/browser");

    expect(getRegistryItems).toHaveBeenCalledWith(["https://eve.dev/r/extension/browser.json"], {
      config: {
        registries: { "@acme": "https://example.com/r/{name}.json" },
      },
    });
    expect(logger.logs).toEqual([
      JSON.stringify({ name: "browser", type: "registry:item" }, null, 2),
    ]);
  });
});
