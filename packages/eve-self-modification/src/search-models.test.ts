import { afterEach, describe, expect, it, vi } from "vitest";

import searchModels, {
  parseGatewayModels,
  searchGatewayModels,
} from "../extension/tools/search_models.js";

const CATALOG = {
  data: [
    {
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      tags: ["web-search"],
      type: "language",
    },
    {
      id: "openai/gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      tags: ["web-search"],
      type: "language",
    },
    {
      id: "openai/gpt-5.6-luna-fast",
      name: "GPT-5.6 Luna Fast",
      tags: [],
      type: "language",
    },
    {
      id: "openai/gpt-image-1",
      name: "GPT Image",
      tags: ["web-search"],
      type: "image",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("searchGatewayModels", () => {
  it("matches abbreviated model IDs from the /model catalog", () => {
    expect(searchGatewayModels(parseGatewayModels(CATALOG), "sol")).toEqual([
      { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
    ]);
  });

  it("uses the same language-model eligibility as /model", () => {
    expect(searchGatewayModels(parseGatewayModels(CATALOG), "luna")).toEqual([
      {
        id: "openai/gpt-5.6-luna-fast",
        name: "GPT-5.6 Luna Fast",
        provider: "openai",
      },
    ]);
    expect(searchGatewayModels(parseGatewayModels(CATALOG), "image")).toEqual([]);
  });

  it("rejects a malformed catalog", () => {
    expect(() => parseGatewayModels({ models: [] })).toThrow("invalid model catalog");
  });
});

describe("selfmod__search_models", () => {
  it("queries the live AI Gateway model endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => CATALOG,
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchModels.execute({ query: "sol" }, {
      abortSignal: new AbortController().signal,
    } as never);
    if (Symbol.asyncIterator in result) throw new TypeError("search_models must not stream.");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      models: [{ id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" }],
    });
  });
});
