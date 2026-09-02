import { afterEach, describe, expect, it, vi } from "vitest";

import searchRegistry, {
  clearRegistryIndexCache,
  parseRegistryIndex,
  resolveRegistryIndexUrl,
  selectIntegrationPage,
  selectIntegrations,
  type CatalogEntry,
} from "../extension/tools/search_registry.js";

const INDEX = {
  items: [
    {
      name: "channel/slack",
      title: "Slack",
      description: "Talk to the agent from Slack.",
      files: [{ target: "agent/channels/slack.ts" }],
      meta: { eve: { requires: ">=0.30.0" } },
    },
    {
      name: "channel/discord",
      title: "Discord",
      description: "Talk to the agent from Discord.",
      files: [{ target: "agent/channels/discord.ts" }],
    },
    {
      name: "connection/notion",
      title: "Notion",
      description: "Read and write Notion pages.",
      files: [{ target: "agent/connections/notion.ts" }],
    },
    {
      name: "linear",
      title: "Linear",
      description: "Receive delegated Linear work.",
      meta: {
        eve: {
          components: [
            {
              item: "channel/linear-agent",
              label: "Linear agent",
              description: "Delegate Linear work to an agent.",
            },
            { item: "connection/linear", label: "Linear connection" },
          ],
        },
      },
    },
    { name: "instrumentation/langfuse-tracing", files: [{ target: "agent/instrumentation.ts" }] },
    { name: 42 },
  ],
};

function catalog(): readonly CatalogEntry[] {
  return parseRegistryIndex(INDEX);
}

afterEach(() => {
  clearRegistryIndexCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseRegistryIndex", () => {
  it("narrows published entries and skips unreadable ones", () => {
    const entries = catalog();

    expect(entries.map((entry) => entry.address)).toEqual([
      "channel/slack",
      "channel/discord",
      "connection/notion",
      "linear",
      "instrumentation/langfuse-tracing",
    ]);
    expect(entries[0]).toEqual({
      address: "channel/slack",
      authoredTarget: "agent/channels/slack.ts",
      category: "channel",
      description: "Talk to the agent from Slack.",
      requires: ">=0.30.0",
      title: "Slack",
    });
  });

  it("keeps a bundle's components and leaves its category absent", () => {
    const bundle = catalog().find((entry) => entry.address === "linear");

    expect(bundle?.category).toBeUndefined();
    expect(bundle?.components).toEqual(["channel/linear-agent", "connection/linear"]);
  });

  it("labels an item that publishes no title", () => {
    const entry = catalog().find((row) => row.address === "instrumentation/langfuse-tracing");

    expect(entry?.title).toBe("Langfuse Tracing");
  });

  it("returns nothing for a malformed index", () => {
    expect(parseRegistryIndex(null)).toEqual([]);
    expect(parseRegistryIndex({ items: "nope" })).toEqual([]);
  });

  it("reads whether an item declares a setup flow, used by selfmod__registry_add's split rule", () => {
    const entries = parseRegistryIndex({
      items: [
        {
          name: "channel/slack",
          meta: {
            eve: { setup: { package: "eve", bin: "eve", args: ["integration", "setup", "slack"] } },
          },
        },
        { name: "extension/browserbase" },
      ],
    });

    expect(entries.find((entry) => entry.address === "channel/slack")?.declaresSetup).toBe(true);
    expect(
      entries.find((entry) => entry.address === "extension/browserbase")?.declaresSetup,
    ).toBeUndefined();
  });

  it("reads an item's declared environment variable names", () => {
    const entries = parseRegistryIndex({
      items: [
        {
          name: "extension/browserbase",
          envVars: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "" },
        },
        { name: "channel/discord", envVars: {} },
      ],
    });

    expect(entries.find((entry) => entry.address === "extension/browserbase")?.envVars).toEqual([
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
    ]);
    expect(entries.find((entry) => entry.address === "channel/discord")?.envVars).toBeUndefined();
  });
});

describe("selectIntegrations", () => {
  it("returns entries that match any query term and ranks stronger matches first", () => {
    expect(
      selectIntegrations({ entries: catalog(), query: "notion pages" }).map((row) => row.address),
    ).toEqual(["connection/notion"]);
    expect(
      selectIntegrations({
        category: "channel",
        entries: catalog(),
        query: "Slack channel integration",
      }).map((row) => row.address),
    ).toEqual(["channel/slack", "channel/discord"]);
    expect(
      selectIntegrations({ entries: catalog(), query: "linear agent" }).map((row) => row.address),
    ).toEqual(["linear"]);
    expect(
      selectIntegrations({ entries: catalog(), query: "agent notion" }).map((row) => row.address),
    ).toEqual(["connection/notion"]);
    expect(selectIntegrations({ entries: catalog(), query: "nothing here" })).toEqual([]);
  });

  it("includes a bundle whose components match the requested category", () => {
    expect(
      selectIntegrations({ category: "channel", entries: catalog() }).map((row) => row.address),
    ).toEqual(["channel/slack", "channel/discord", "linear"]);
  });

  it("bounds the result count", () => {
    expect(selectIntegrations({ entries: catalog(), limit: 2 })).toHaveLength(2);
    expect(selectIntegrations({ entries: catalog(), limit: 500 })).toHaveLength(5);
  });

  it("reports totals and provides an offset for the next page", () => {
    expect(selectIntegrationPage({ entries: catalog(), limit: 2 })).toEqual({
      hasMore: true,
      items: [
        {
          address: "channel/slack",
          category: "channel",
          description: "Talk to the agent from Slack.",
          requires: ">=0.30.0",
          title: "Slack",
        },
        {
          address: "channel/discord",
          category: "channel",
          description: "Talk to the agent from Discord.",
          title: "Discord",
        },
      ],
      nextOffset: 2,
      total: 5,
    });
    expect(selectIntegrationPage({ entries: catalog(), limit: 2, offset: 4 })).toMatchObject({
      hasMore: false,
      items: [{ address: "instrumentation/langfuse-tracing", title: "Langfuse Tracing" }],
      total: 5,
    });
  });

  it("returns presentation fields only", () => {
    const [row] = selectIntegrations({ entries: catalog(), query: "slack" });

    expect(row).toEqual({
      address: "channel/slack",
      category: "channel",
      description: "Talk to the agent from Slack.",
      requires: ">=0.30.0",
      title: "Slack",
    });
  });
});

describe("resolveRegistryIndexUrl", () => {
  it("defaults to the official registry index", () => {
    expect(resolveRegistryIndexUrl(undefined)).toBe("https://eve.dev/r/registry.json");
  });

  it("honors an HTTP(S) override, trailing slash included", () => {
    expect(resolveRegistryIndexUrl("http://localhost:4000/r")).toBe(
      "http://localhost:4000/r/registry.json",
    );
    expect(resolveRegistryIndexUrl("http://localhost:4000/r/")).toBe(
      "http://localhost:4000/r/registry.json",
    );
  });

  it("rejects an override that is not a plain HTTP(S) location", () => {
    expect(() => resolveRegistryIndexUrl("file:///tmp/r")).toThrow("HTTP(S) URL");
    expect(() => resolveRegistryIndexUrl("https://user:pass@example.com/r")).toThrow(
      "must not include credentials",
    );
    expect(() => resolveRegistryIndexUrl("https://example.com/r?token=abc")).toThrow(
      "query or fragment",
    );
  });
});

describe("selfmod__search_registry", () => {
  function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => response.body,
      ok: response.ok,
      status: response.status ?? 200,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Narrows the tool's promise-or-stream return to its resolved object. */
  async function run(input: Record<string, unknown>, context: never) {
    const result = await searchRegistry.execute(input, context);
    if (Symbol.asyncIterator in result) {
      throw new TypeError("search_registry must not stream its result.");
    }
    return result;
  }

  function ctx(files: Record<string, string> = {}) {
    return {
      getSandbox: async () => ({
        readTextFile: async ({ path }: { path: string }) => files[path] ?? null,
      }),
    } as never;
  }

  it("returns catalog rows with installed state from the source mount", async () => {
    stubFetch({ body: INDEX, ok: true });

    const result = await run(
      { category: "channel" },
      ctx({ "/source/channels/slack.ts": "export default {}" }),
    );

    expect(result).toEqual({
      errors: [],
      hasMore: false,
      items: [
        {
          address: "channel/slack",
          category: "channel",
          description: "Talk to the agent from Slack.",
          installed: true,
          requires: ">=0.30.0",
          title: "Slack",
        },
        {
          address: "channel/discord",
          category: "channel",
          description: "Talk to the agent from Discord.",
          installed: false,
          title: "Discord",
        },
        {
          address: "linear",
          components: ["channel/linear-agent", "connection/linear"],
          description: "Receive delegated Linear work.",
          title: "Linear",
        },
      ],
      total: 3,
    });
  });

  it("leaves installed absent when the source cannot be read", async () => {
    stubFetch({ body: INDEX, ok: true });

    const result = await run({ query: "slack" }, {
      getSandbox: async () => {
        throw new Error("no sandbox");
      },
    } as never);

    expect(result).toMatchObject({
      hasMore: false,
      items: [
        {
          address: "channel/slack",
          category: "channel",
          description: "Talk to the agent from Slack.",
          requires: ">=0.30.0",
          title: "Slack",
        },
      ],
      total: 1,
    });
  });

  it("reports a catalog failure instead of throwing", async () => {
    stubFetch({ ok: false, status: 503 });

    const result = await run({}, ctx());

    expect(result).toEqual({
      errors: [
        {
          message: "Could not read the eve registry (503).",
          registry: "https://eve.dev/r/registry.json",
        },
      ],
      hasMore: false,
      items: [],
      total: 0,
    });
  });

  it("combines the turn abort signal with the registry timeout", async () => {
    const fetchMock = stubFetch({ body: INDEX, ok: true });
    const controller = new AbortController();

    await run({}, {
      abortSignal: controller.signal,
      getSandbox: async () => ({
        readTextFile: async () => null,
      }),
    } as never);

    const options = fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal).not.toBe(controller.signal);
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  it("serves repeat searches from one fetch", async () => {
    const fetchMock = stubFetch({ body: INDEX, ok: true });

    await run({ query: "slack" }, ctx());
    await run({ query: "notion" }, ctx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
