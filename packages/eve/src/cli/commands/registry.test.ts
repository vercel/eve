import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runAddCommand,
  runRegistryAddCommand,
  runRegistryListCommand,
  runRegistrySearchCommand,
  runRegistryViewCommand,
  type RegistryCommandLogger,
} from "./registry.js";

const { addRegistryItems, getRegistryItems, isEveProject, readFile, searchRegistries, writeFile } =
  vi.hoisted(() => ({
    addRegistryItems: vi.fn(),
    getRegistryItems: vi.fn(),
    isEveProject: vi.fn(),
    readFile: vi.fn(),
    searchRegistries: vi.fn(),
    writeFile: vi.fn(),
  }));

vi.mock("#compiled/shadcn-registry/index.js", () => ({
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
}));

vi.mock("#setup/scaffold/index.js", () => ({ isEveProject }));
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
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("installs official items through the registry SDK", async () => {
    const logger = createLogger();

    await runAddCommand(logger, "/project", "extension/browser", {
      overwrite: true,
    });

    expect(addRegistryItems).toHaveBeenCalledWith(["https://eve.dev/r/extension/browser.json"], {
      cwd: "/project",
      overwrite: true,
    });
    expect(logger.errors).toEqual([]);
  });

  it("adds namespace mappings to components.json", async () => {
    const logger = createLogger();

    await runRegistryAddCommand(logger, "/project", ["@other=https://other.example/r/{name}.json"]);

    expect(writeFile).toHaveBeenCalledWith(
      "/project/components.json",
      `${JSON.stringify(
        {
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
    expect(logger.logs).toContain("Added @other to components.json.");
  });

  it("guides projects without components.json to install by URL", async () => {
    const logger = createLogger();
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await runRegistryAddCommand(logger, "/project", ["@other=https://other.example/r/{name}.json"]);

    expect(writeFile).not.toHaveBeenCalled();
    expect(logger.errors).toEqual([
      "Adding a registry namespace requires an existing components.json. " +
        "Use an item URL with `eve add <url>` when the project is not configured for shadcn.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("lists the official registry without components.json", async () => {
    const logger = createLogger();
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
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

  it("searches the official catalog and configured registries", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "@acme",
          name: "browser",
          addCommandArgument: "@acme/browser",
          description: "Browser tools",
        },
      ],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    });

    await runRegistrySearchCommand(logger, "/project", "browser");

    expect(searchRegistries).toHaveBeenCalledWith(["https://eve.dev/r/registry.json", "@acme"], {
      config: {
        registries: { "@acme": "https://example.com/r/{name}.json" },
      },
      continueOnError: true,
      query: "browser",
    });
    expect(logger.logs).toEqual(["@acme/browser — Browser tools"]);
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
