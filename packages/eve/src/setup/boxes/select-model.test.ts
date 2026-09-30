import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGatewayModelCatalog } from "#shared/gateway-model-catalog.js";

import {
  fetchGatewayCatalog,
  modelOptionsFromCatalog,
  type GatewayCatalogModel,
} from "./select-model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("identifies eve when fetching the AI Gateway catalog", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await fetchGatewayCatalog();

  const [, init] = fetchMock.mock.calls[0]!;
  expect(new Headers(init?.headers).get("user-agent")).toMatch(/^eve\/.+/);
});

const CATALOG: GatewayCatalogModel[] = [
  {
    id: "zai/glm-4.6",
    name: "GLM 4.6",
    type: "language",
    owned_by: "zai",
    released: 300,
    tags: ["web-search"],
    reasoningEfforts: [],
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    type: "language",
    owned_by: "openai",
    released: 200,
    tags: ["web-search"],
    reasoningEfforts: [],
  },
  {
    id: "openai/gpt-6-luna-fast",
    name: "GPT-6 Luna Fast",
    type: "language",
    owned_by: "openai",
    released: 100,
    tags: ["reasoning"],
    reasoningEfforts: [],
  },
  // Filtered out: not a language model.
  {
    id: "openai/dall-e-3",
    name: "DALL-E 3",
    type: "image",
    owned_by: "openai",
    reasoningEfforts: [],
  },
  // Filtered out: missing the web-search tag.
  {
    id: "google/gemma-2",
    name: "Gemma 2",
    type: "language",
    owned_by: "google",
    tags: [],
    reasoningEfforts: [],
  },
];

describe("modelOptionsFromCatalog", () => {
  it("filters, sorts newest-first behind the featured lead, and marks the shortlist", () => {
    const options = modelOptionsFromCatalog(CATALOG);

    expect(options.map((option) => option.value)).toEqual([
      "openai/gpt-6-luna-fast",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    expect(options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "openai/gpt-6-luna-fast",
    ]);
    expect(options[0]?.hint).toBe("OpenAI");
  });

  it("falls back to the static shortlist without a catalog or matches", () => {
    for (const catalog of [undefined, [] as GatewayCatalogModel[]]) {
      const options = modelOptionsFromCatalog(catalog);
      expect(options[0]).toEqual({
        id: "openai/gpt-6-luna-fast",
        value: "openai/gpt-6-luna-fast",
        label: "GPT-6 Luna Fast",
        hint: "OpenAI",
        featured: true,
      });
      expect(options.map((option) => option.value)).toContain("google/gemini-3.5");
    }
  });

  it("orders the curated shortlist first and marks only it featured", () => {
    // The curated order keeps the default ahead of the newer Opus entry.
    const options = modelOptionsFromCatalog([
      {
        id: "anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        type: "language",
        owned_by: "anthropic",
        released: 400,
        tags: ["web-search"],
        reasoningEfforts: [],
      },
      ...CATALOG,
    ]);

    expect(options.map((option) => option.value)).toEqual([
      "openai/gpt-6-luna-fast",
      "anthropic/claude-opus-4.8",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    expect(options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "openai/gpt-6-luna-fast",
      "anthropic/claude-opus-4.8",
    ]);
  });

  it("sorts undated models after dated models with deterministic ties", () => {
    const model = (id: string, name: string, released?: number): GatewayCatalogModel => {
      const entry: GatewayCatalogModel = {
        id,
        name,
        type: "language",
        owned_by: "acme",
        tags: ["web-search"],
        reasoningEfforts: [],
      };
      if (released !== undefined) entry.released = released;
      return entry;
    };

    const options = modelOptionsFromCatalog([
      model("acme/undated", "Undated"),
      model("acme/zeta", "Same release Zeta", 100),
      model("acme/alpha", "Same release Alpha", 100),
      model("acme/newer", "Newer", 200),
    ]);

    expect(options.map((option) => option.value)).toEqual([
      "acme/newer",
      "acme/alpha",
      "acme/zeta",
      "acme/undated",
    ]);
  });
});

describe("parseGatewayModelCatalog", () => {
  it("skips malformed catalog entries instead of rejecting the whole catalog", () => {
    const models = parseGatewayModelCatalog({
      data: [
        CATALOG[0],
        { id: "vendor/experimental", shape: "unrecognized" },
        "not even an object",
        CATALOG[1],
      ],
    });

    expect(models.map((model) => model.id)).toEqual(["zai/glm-4.6", "openai/gpt-5-mini"]);
  });

  it("keeps valid reasoning efforts while ignoring malformed optional metadata", () => {
    expect(
      parseGatewayModelCatalog({
        data: [
          {
            id: "vendor/experimental",
            name: "Experimental",
            type: "language",
            owned_by: "vendor",
            released: "unannounced",
            tags: null,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high"] },
              { type: "effort", values: null },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "vendor/experimental",
        name: "Experimental",
        type: "language",
        owned_by: "vendor",
        reasoningEfforts: ["low", "high"],
      },
    ]);
  });

  it("rejects a catalog payload without a data array", () => {
    expect(() => parseGatewayModelCatalog({ models: [] })).toThrow("invalid model catalog");
  });
});
