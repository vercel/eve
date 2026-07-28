import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runAddCommand,
  runRegistryAddCommand,
  runRegistryListCommand,
  runRegistrySearchCommand,
  runRegistryViewCommand,
  type RegistryCommandLogger,
} from "./registry.js";

const {
  addRegistryItems,
  getRegistryItems,
  isEveProject,
  readFile,
  resolveInstalledPackageInfo,
  searchRegistries,
  writeFile,
} = vi.hoisted(() => ({
  addRegistryItems: vi.fn(),
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
    process.exitCode = undefined;
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
    });
    expect(logger.errors).toEqual([]);
  });

  it.each(["web", "slack"] as const)(
    "installs the official %s item before running its declared setup",
    async (kind) => {
      const logger = createLogger();
      const runSetupCommand = vi.fn(async () => {});
      getRegistryItems.mockResolvedValue([
        {
          name: `channel/${kind}`,
          type: "registry:item",
          meta: {
            eve: {
              setup: { command: "eve", args: ["integration", "setup", kind] },
            },
          },
        },
      ]);

      await runAddCommand(
        logger,
        "/project",
        `channel/${kind}`,
        { overwrite: true },
        {
          loadSetupCommandRunner: async () => runSetupCommand,
        },
      );

      expect(addRegistryItems).toHaveBeenCalledOnce();
      expect(addRegistryItems.mock.invocationCallOrder[0]).toBeLessThan(
        runSetupCommand.mock.invocationCallOrder[0]!,
      );
      expect(runSetupCommand).toHaveBeenCalledWith("/project", {
        command: "eve",
        args: ["integration", "setup", kind],
      });
    },
  );

  it("does not infer setup from the item address", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => {});
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
    const runSetupCommand = vi.fn(async () => {});
    getRegistryItems.mockResolvedValue([
      {
        name: "channel/web",
        type: "registry:item",
        meta: {
          eve: {
            setup: { command: "eve", args: ["integration", "setup", "web"] },
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
  });

  it("rejects invalid official setup metadata before installation", async () => {
    const logger = createLogger();
    getRegistryItems.mockResolvedValue([
      {
        name: "channel/unknown",
        type: "registry:item",
        meta: {
          eve: {
            setup: { command: "sh", args: ["-c", "echo nope"] },
          },
        },
      },
    ]);

    await runAddCommand(logger, "/project", "channel/unknown", {});

    expect(logger.errors).toHaveLength(1);
    expect(addRegistryItems).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
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
            setup: { command: "eve", args: ["integration", "setup", "web"] },
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
