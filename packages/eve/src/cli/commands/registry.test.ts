import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import {
  browseRegistryCatalog,
  installRegistryItem,
  runAddCommand,
  runRegistryAddCommand,
  runRegistryListCommand,
  runRegistrySearchCommand,
  resolveOfficialRegistryUrl,
  runRegistryViewCommand,
  type RegistryCommandLogger,
} from "./registry.js";
import type {
  RegistrySetupCommand,
  RegistrySetupCommandOptions,
} from "./registry-setup-command.js";

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    isEveProject.mockResolvedValue(true);
    getRegistryItems.mockResolvedValue([]);
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
    vi.unstubAllGlobals();
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
        registries: {
          "@skills": "https://www.skills.sh/r/{name}?agent=eve",
          "@acme": "https://example.com/r/{name}.json",
        },
      },
    });
    expect(addRegistryItems).toHaveBeenCalledWith(["https://eve.dev/r/extension/browser.json"], {
      config: {
        registries: {
          "@skills": "https://www.skills.sh/r/{name}?agent=eve",
          "@acme": "https://example.com/r/{name}.json",
        },
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
              setup: [{ package: "eve", bin: "eve", args: ["integration", "setup", kind] }],
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

  it("lets interactive users select components from an official registry package", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    const fake = createFakePrompter({
      multiple: (options) => {
        expect(options).toMatchObject({
          message: "Add linear",
          description: "Select what you want to add to your agent.",
          initialValues: ["channel/linear-agent", "connection/linear"],
        });
        return ["connection/linear"];
      },
    });
    getRegistryItems
      .mockResolvedValueOnce([
        {
          meta: {
            eve: {
              components: [
                {
                  item: "channel/linear-agent",
                  label: "Linear Agent",
                  description: "Receive delegated issues and Agent Sessions",
                  default: true,
                },
                {
                  item: "connection/linear",
                  label: "Linear tools",
                  description: "Search and update Linear issues",
                  default: true,
                },
              ],
            },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          meta: {
            eve: {
              setup: [
                {
                  package: "eve",
                  bin: "eve",
                  args: ["integration", "connect", "linear", "mcp.linear.app", "linear"],
                },
              ],
            },
          },
        },
      ]);

    await runAddCommand(
      logger,
      "/project",
      "linear",
      { prompter: fake.prompter },
      { isInteractive: () => true, loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(addRegistryItems).toHaveBeenCalledWith(
      ["https://eve.dev/r/connection/linear.json"],
      expect.objectContaining({ cwd: "/project" }),
    );
    expect(runSetupCommand).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        args: ["integration", "connect", "linear", "mcp.linear.app", "linear"],
      }),
      "linear",
      expect.objectContaining({ prompter: fake.prompter }),
    );
  });

  it("cancels registry package component selection without reporting an error", async () => {
    const logger = createLogger();
    const fake = createFakePrompter({
      multiple: () => {
        throw new WizardCancelledError();
      },
    });
    getRegistryItems.mockResolvedValueOnce([
      {
        meta: {
          eve: {
            components: [
              { item: "channel/linear-agent", label: "Linear Agent", default: true },
              { item: "connection/linear", label: "Linear tools", default: true },
            ],
          },
        },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "linear",
      { prompter: fake.prompter },
      { isInteractive: () => true, loadSetupCommandRunner: vi.fn() },
    );

    expect(logger.errors).toEqual([]);
    expect(addRegistryItems).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps registry package setup interactive when called from the TUI", async () => {
    const fake = createFakePrompter({
      multiple: () => ["channel/linear-agent", "connection/linear"],
      single: () => "yes",
    });
    const runSetupCommand = vi.fn(
      async (
        _appRoot: string,
        _setup: RegistrySetupCommand,
        _item: string,
        _options?: RegistrySetupCommandOptions,
      ) => ({ kind: "completed" as const, output: [] }),
    );
    getRegistryItems
      .mockResolvedValueOnce([
        {
          meta: {
            eve: {
              components: [
                { item: "channel/linear-agent", label: "Linear Agent", default: true },
                { item: "connection/linear", label: "Linear tools", default: true },
              ],
            },
          },
        },
      ])
      .mockResolvedValueOnce([
        { meta: { eve: { setup: [{ package: "eve", bin: "eve", args: ["channel-setup"] }] } } },
        { meta: { eve: { setup: [{ package: "eve", bin: "eve", args: ["connection-setup"] }] } } },
      ]);

    await installRegistryItem(
      "/project",
      "linear",
      { prompter: fake.prompter },
      { loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(fake.selectMessages).toEqual(["Add linear"]);
    expect(runSetupCommand).toHaveBeenCalledTimes(2);
    expect(runSetupCommand.mock.calls[0]?.[1]).toEqual({
      package: "eve",
      bin: "eve",
      args: ["channel-setup"],
    });
  });

  it("installs a registry package's default components with --yes", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems
      .mockResolvedValueOnce([
        {
          meta: {
            eve: {
              components: [
                { item: "channel/linear-agent", label: "Linear Agent", default: true },
                { item: "connection/linear", label: "Linear tools", default: true },
              ],
            },
          },
        },
      ])
      .mockResolvedValueOnce([
        { meta: { eve: { setup: [{ package: "eve", bin: "eve", args: ["channel-setup"] }] } } },
        { meta: { eve: { setup: [{ package: "eve", bin: "eve", args: ["connection-setup"] }] } } },
      ]);

    await runAddCommand(
      logger,
      "/project",
      "linear",
      { yes: true },
      { loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(addRegistryItems).toHaveBeenCalledWith(
      ["https://eve.dev/r/channel/linear-agent.json", "https://eve.dev/r/connection/linear.json"],
      expect.objectContaining({ cwd: "/project" }),
    );
    expect(runSetupCommand).toHaveBeenCalledTimes(2);
  });

  it("accepts a legacy singular setup command", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([
      {
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
      "channel/web",
      { yes: true },
      { loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(runSetupCommand).toHaveBeenCalledWith(
      "/project",
      { package: "eve", bin: "eve", args: ["integration", "setup", "web", "--yes"] },
      "channel/web",
      expect.objectContaining({ prompter: expect.any(Object) }),
    );
  });

  it("runs declared setups in order after installation", async () => {
    const logger = createLogger();
    const prompters: unknown[] = [];
    const runSetupCommand = vi.fn(
      async (
        _appRoot: string,
        _setup: RegistrySetupCommand,
        _item: string,
        options?: RegistrySetupCommandOptions,
      ) => {
        prompters.push(options?.prompter);
        return { kind: "completed" as const, output: [] };
      },
    );
    getRegistryItems.mockResolvedValue([
      {
        meta: {
          eve: {
            setup: [
              { package: "eve", bin: "eve", args: ["integration", "setup", "linear-channel"] },
              { package: "eve", bin: "eve", args: ["integration", "connect", "linear"] },
            ],
          },
        },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "integration/linear",
      { yes: true },
      { loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(runSetupCommand).toHaveBeenNthCalledWith(
      1,
      "/project",
      { package: "eve", bin: "eve", args: ["integration", "setup", "linear-channel", "--yes"] },
      "integration/linear",
      expect.objectContaining({ prompter: expect.any(Object) }),
    );
    expect(runSetupCommand).toHaveBeenNthCalledWith(
      2,
      "/project",
      { package: "eve", bin: "eve", args: ["integration", "connect", "linear", "--yes"] },
      "integration/linear",
      expect.objectContaining({ prompter: expect.any(Object) }),
    );
    expect(prompters[0]).toBe(prompters[1]);
  });

  it("stops declared setups when one is cancelled", async () => {
    const logger = createLogger();
    const runSetupCommand = vi.fn(async () => ({ kind: "cancelled" as const }));
    getRegistryItems.mockResolvedValue([
      {
        meta: {
          eve: {
            setup: [
              { package: "eve", bin: "eve", args: ["integration", "setup", "linear-channel"] },
              { package: "eve", bin: "eve", args: ["integration", "connect", "linear"] },
            ],
          },
        },
      },
    ]);

    await runAddCommand(
      logger,
      "/project",
      "integration/linear",
      { yes: true },
      { loadSetupCommandRunner: async () => runSetupCommand },
    );

    expect(runSetupCommand).toHaveBeenCalledOnce();
    expect(logger.logs).toEqual([
      "Setup cancelled. Run `eve add integration/linear --skip-install` when you're ready.",
    ]);
  });

  it("skips setup in non-interactive use and prints the resume command", async () => {
    const logger = createLogger();
    const runSetup = vi.fn(async () => ({ kind: "completed" as const, output: [] }));
    getRegistryItems.mockResolvedValue([
      {
        meta: { eve: { setup: [{ package: "@acme/slack", bin: "eve-slack", args: ["setup"] }] } },
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
        meta: { eve: { setup: [{ package: "@acme/slack", bin: "eve-slack", args: ["setup"] }] } },
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
        meta: { eve: { setup: [{ package: "@acme/slack", bin: "eve-slack", args: ["setup"] }] } },
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
        meta: { eve: { setup: [{ package: "@acme/slack", bin: "eve-slack", args: ["setup"] }] } },
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
            setup: [{ package: "eve", bin: "eve", args: ["integration", "setup", "web"] }],
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
            setup: [{ package: "shell-package", bin: "sh", args: ["-c", "echo nope"] }],
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
        name: "channel/photon-imessage",
        type: "registry:item",
        meta: {
          eve: {
            requires: ">=0.30.0",
            setup: [{ package: "eve", bin: "eve", args: ["integration", "setup", "web"] }],
          },
        },
      },
    ]);

    await runAddCommand(logger, "/project", "channel/photon-imessage", {});

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

  it("loads real item titles in parallel for a page of search results", async () => {
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "https://eve.dev/r/registry.json",
          name: "channel/photon-imessage",
          addCommandArgument: "https://eve.dev/r/channel/photon-imessage.json",
        },
        {
          registry: "@acme",
          name: "extension/ai-sdk-tools",
          addCommandArgument: "@acme/ai-sdk-tools",
        },
      ],
      pagination: { total: 2, offset: 0, limit: 2, hasMore: false },
    });
    const resolvers = new Map<string, (value: unknown[]) => void>();
    getRegistryItems.mockImplementation(
      ([address]: string[]) =>
        new Promise((resolve) => {
          resolvers.set(address!, resolve);
        }),
    );

    const catalog = browseRegistryCatalog("/project", { query: "sdk" });

    await vi.waitFor(() => expect(getRegistryItems).toHaveBeenCalledTimes(2));
    resolvers.get("https://eve.dev/r/channel/photon-imessage.json")?.([
      { title: "Photon iMessage" },
    ]);
    resolvers.get("@acme/ai-sdk-tools")?.([{ title: "AI SDK Tools" }]);
    await expect(catalog).resolves.toMatchObject({
      items: [
        { name: "channel/photon-imessage", title: "Photon iMessage" },
        { name: "extension/ai-sdk-tools", title: "AI SDK Tools" },
      ],
    });
    expect(searchRegistries).toHaveBeenCalledWith(
      ["https://eve.dev/r/registry.json"],
      expect.objectContaining({ limit: 100, query: "sdk" }),
    );
    expect(searchRegistries).toHaveBeenCalledWith(
      ["@acme"],
      expect.objectContaining({ limit: 100, query: "sdk" }),
    );
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
      config: { registries: { "@skills": "https://www.skills.sh/r/{name}?agent=eve" } },
      limit: 100,
      query: undefined,
    });
    expect(logger.logs).toEqual(["No registry items found."]);
  });

  it("emits list results as JSON", async () => {
    const logger = createLogger();
    const result = {
      items: [{ registry: "https://eve.dev/r/registry.json", name: "extension/browser" }],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    };
    searchRegistries.mockResolvedValue(result);

    await runRegistryListCommand(logger, "/project", undefined, { json: true });

    expect(logger.logs).toEqual([
      JSON.stringify(
        {
          ...result,
          pagination: { hasMore: false, limit: 100, offset: 0, total: 1 },
        },
        null,
        2,
      ),
    ]);
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
      [
        "https://example.com/r/registry.json (1 result)",
        "  search",
        "    https://example.com/r/search.json",
        "    External search tools",
      ].join("\n"),
    ]);
  });

  it("segments search results by source and shows each source's available results", async () => {
    const logger = createLogger();
    searchRegistries.mockImplementation(async ([source]: string[]) => {
      if (source === "https://eve.dev/r/registry.json") {
        return {
          items: [
            {
              registry: source,
              name: "extension/agent-browser",
              addCommandArgument: "https://eve.dev/r/extension/agent-browser.json",
              description: "Browser automation",
            },
          ],
          pagination: { total: 1, offset: 0, limit: 10, hasMore: false },
        };
      }
      if (source === "@skills") {
        return {
          items: [
            {
              registry: source,
              name: "browser",
              addCommandArgument: "@skills/example/browser",
              description: "Browser skills",
            },
          ],
          pagination: { total: 200, offset: 0, limit: 10, hasMore: true },
        };
      }
      return {
        items: [
          {
            registry: source!,
            name: "browser",
            addCommandArgument: "@acme/browser",
            description: "Browser tools",
          },
        ],
        pagination: { total: 1, offset: 0, limit: 10, hasMore: false },
      };
    });

    await runRegistrySearchCommand(logger, "/project", "browser");

    expect(searchRegistries).toHaveBeenCalledWith(["https://eve.dev/r/registry.json"], {
      config: {
        registries: {
          "@skills": "https://www.skills.sh/r/{name}?agent=eve",
          "@acme": "https://example.com/r/{name}.json",
        },
      },
      limit: 10,
      query: "browser",
    });
    expect(searchRegistries).toHaveBeenCalledWith(
      ["@skills"],
      expect.objectContaining({ limit: 10 }),
    );
    expect(searchRegistries).toHaveBeenCalledWith(
      ["@acme"],
      expect.objectContaining({ limit: 10 }),
    );
    expect(logger.logs).toEqual([
      [
        "eve (1 result)",
        "  agent-browser",
        "    extension/agent-browser",
        "    Browser automation",
        "skills.sh (showing 1 of 200 results)",
        "  browser",
        "    @skills/example/browser",
        "    Browser skills",
        "@acme (1 result)",
        "  browser",
        "    @acme/browser",
        "    Browser tools",
      ].join("\n"),
    ]);
  });

  it("limits search results and reports the total match count", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: Array.from({ length: 5 }, (_, index) => ({
        registry: "@acme",
        name: `result-${index + 1}`,
        addCommandArgument: `@acme/result-${index + 1}`,
      })),
      pagination: { total: 21, offset: 0, limit: 5, hasMore: true },
    });

    await runRegistrySearchCommand(logger, "/project", "web", undefined, { limit: 5 });

    expect(searchRegistries).toHaveBeenCalledWith(
      ["https://eve.dev/r/registry.json"],
      expect.objectContaining({ limit: 5, query: "web" }),
    );
    expect(logger.logs[0]).toMatch(/^@acme \(showing 5 of 21 results\)/);
  });

  it("puts descriptions below long addresses instead of creating a narrow second column", async () => {
    const logger = createLogger();
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "@skills",
          name: "vercel-react-best-practices",
          addCommandArgument:
            "@skills/vercel-labs/agent-skills/vercel-react-best-practices-with-a-long-name",
          description:
            "React and Next.js performance optimization guidelines from Vercel Engineering.",
        },
      ],
      pagination: { total: 200, offset: 0, limit: 10, hasMore: true },
    });

    try {
      await runRegistrySearchCommand(logger, "/project", "react", "@skills");
    } finally {
      if (columnsDescriptor === undefined) {
        Reflect.deleteProperty(process.stdout, "columns");
      } else {
        Object.defineProperty(process.stdout, "columns", columnsDescriptor);
      }
    }

    expect(logger.logs).toEqual([
      [
        "skills.sh (showing 1 of 200 results)",
        "  vercel-react-best-practices",
        "    @skills/vercel-labs/agent-skills/vercel-react-best-practices-with-a-long-name",
        "    React and Next.js performance optimization guidelines from Vercel Engineering.",
      ].join("\n"),
    ]);
  });

  it("sanitizes and wraps registry descriptions beneath their addresses", async () => {
    const logger = createLogger();
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 40 });
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "@acme",
          name: "browser",
          addCommandArgument: "@acme/browser",
          description:
            "A long registry description that wraps cleanly\n beneath its \u001B]0;spoofed\u0007address.",
        },
      ],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    });

    try {
      await runRegistrySearchCommand(logger, "/project", "browser\u001B]0;spoofed\u0007");
    } finally {
      if (columnsDescriptor === undefined) {
        Reflect.deleteProperty(process.stdout, "columns");
      } else {
        Object.defineProperty(process.stdout, "columns", columnsDescriptor);
      }
    }

    expect(logger.logs).toEqual([
      [
        "@acme (1 result)",
        "  browser",
        "    @acme/browser",
        "    A long registry description that",
        "    wraps cleanly beneath its address.",
      ].join("\n"),
    ]);
    expect(logger.logs[0]).not.toContain("spoofed");
    expect(logger.logs[0]).not.toContain("\u001B");
  });

  it("shows a concise first sentence and fixes escaped quotes", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [
        {
          registry: "@acme",
          name: "resources",
          addCommandArgument: "@acme/resources",
          description:
            'Use when asked to \\"list resources\\". WHEN: inventory, tags, subscriptions, resource groups, virtual machines, websites, storage accounts.',
        },
      ],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    });

    await runRegistrySearchCommand(logger, "/project", "resources");

    expect(logger.logs).toEqual([
      [
        "@acme (1 result)",
        "  resources",
        "    @acme/resources",
        '    Use when asked to "list resources".',
      ].join("\n"),
    ]);
  });

  it("names the active filter in an empty search result", async () => {
    const logger = createLogger();
    searchRegistries.mockResolvedValue({
      items: [],
      pagination: { total: 0, offset: 0, limit: 10, hasMore: false },
    });

    await runRegistrySearchCommand(logger, "/project", "missing");

    expect(logger.logs).toEqual(['No registry items match "missing".']);
  });

  it("emits search results as JSON", async () => {
    const logger = createLogger();
    const result = {
      items: [{ registry: "@acme", name: "browser", addCommandArgument: "@acme/browser" }],
      pagination: { total: 1, offset: 0, limit: 1, hasMore: false },
    };
    searchRegistries.mockResolvedValue(result);

    await runRegistrySearchCommand(logger, "/project", "browser", undefined, { json: true });

    expect(logger.logs).toEqual([
      JSON.stringify(
        {
          ...result,
          pagination: { hasMore: false, limit: 10, offset: 0, total: 1 },
        },
        null,
        2,
      ),
    ]);
  });

  it("emits JSON when every registry search fails", async () => {
    const logger = createLogger();
    const result = {
      items: [],
      errors: [{ registry: "https://eve.dev/r/registry.json", message: "eve unavailable" }],
      pagination: { total: 0, offset: 0, limit: 0, hasMore: false },
    };
    searchRegistries.mockResolvedValue(result);

    await runRegistryListCommand(logger, "/project", undefined, { json: true });

    expect(logger.logs).toEqual([
      JSON.stringify(
        {
          items: [],
          pagination: { hasMore: false, limit: 100, offset: 0, total: 0 },
          errors: result.errors,
        },
        null,
        2,
      ),
    ]);
    expect(logger.errors).toEqual(["https://eve.dev/r/registry.json: eve unavailable"]);
    expect(process.exitCode).toBe(1);
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
        registries: {
          "@skills": "https://www.skills.sh/r/{name}?agent=eve",
          "@acme": "https://example.com/r/{name}.json",
        },
      },
    });
    expect(logger.logs).toEqual([
      JSON.stringify({ name: "browser", type: "registry:item" }, null, 2),
    ]);
  });
});
