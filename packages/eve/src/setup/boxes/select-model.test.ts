import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import {
  fetchGatewayCatalog,
  modelOptionsFromCatalog,
  parseGatewayCatalog,
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
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    type: "language",
    owned_by: "openai",
    released: 200,
    tags: ["web-search"],
  },
  {
    id: "spacexai/grok-4.7",
    name: "Grok 4.7",
    type: "language",
    owned_by: "spacexai",
    released: 100,
    tags: ["reasoning"],
  },
  // Filtered out: not a language model.
  { id: "openai/dall-e-3", name: "DALL-E 3", type: "image", owned_by: "openai" },
  // Filtered out: missing the web-search tag.
  { id: "google/gemma-2", name: "Gemma 2", type: "language", owned_by: "google", tags: [] },
];

describe("modelOptionsFromCatalog", () => {
  it("filters, sorts newest-first behind the featured lead, and marks the shortlist", () => {
    const options = modelOptionsFromCatalog(CATALOG);

    expect(options.map((option) => option.value)).toEqual([
      "spacexai/grok-4.7",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    expect(options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "spacexai/grok-4.7",
    ]);
    expect(options[0]?.hint).toBe("SpaceXAI");
  });

  it("falls back to the static shortlist without a catalog or matches", () => {
    for (const catalog of [undefined, [] as GatewayCatalogModel[]]) {
      const values = modelOptionsFromCatalog(catalog).map((option) => option.value);
      expect(values).toContain(DEFAULT_AGENT_MODEL_ID);
      expect(values).toContain("google/gemini-3.5");
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
      },
      ...CATALOG,
    ]);

    expect(options.map((option) => option.value)).toEqual([
      "spacexai/grok-4.7",
      "anthropic/claude-opus-4.8",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    expect(options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "spacexai/grok-4.7",
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

describe("parseGatewayCatalog", () => {
  it("skips malformed catalog entries instead of rejecting the whole catalog", () => {
    const models = parseGatewayCatalog({
      data: [
        CATALOG[0],
        { id: "vendor/experimental", shape: "unrecognized" },
        "not even an object",
        CATALOG[1],
      ],
    });

    expect(models.map((model) => model.id)).toEqual(["zai/glm-4.6", "openai/gpt-5-mini"]);
  });

  it("keeps a model when only its optional catalog metadata is malformed", () => {
    expect(
      parseGatewayCatalog({
        data: [
          {
            id: "vendor/experimental",
            name: "Experimental",
            type: "language",
            owned_by: "vendor",
            released: "unannounced",
            tags: null,
          },
        ],
      }),
    ).toEqual([
      {
        id: "vendor/experimental",
        name: "Experimental",
        type: "language",
        owned_by: "vendor",
      },
    ]);
  });

  it("rejects a catalog payload without a data array", () => {
    expect(() => parseGatewayCatalog({ models: [] })).toThrow("invalid model catalog");
  });
});
