import { describe, expect, it } from "vitest";

import { webSearch } from "#public/tools/web-search.js";

describe("webSearch", () => {
  it.each(["parallel", "exa"] as const)("configures the %s provider", (provider) => {
    expect(webSearch({ provider })).toEqual({
      kind: "eve:web-search-tool",
      provider,
    });
  });
});
