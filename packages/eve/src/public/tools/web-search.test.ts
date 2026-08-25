import { describe, expect, it } from "vitest";

import { isHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";
import { webSearch } from "#public/tools/web-search.js";

describe("webSearch", () => {
  it.each(["parallel", "exa"] as const)("configures the %s provider", (provider) => {
    const definition = webSearch({ provider });

    expect(definition.kind).toBe("eve:web-search-tool");
    expect(definition.provider).toBe(provider);
    expect(isHarnessOwnedToolDefinition(definition)).toBe(true);
  });

  it("omits the provider when called with no argument", () => {
    const definition = webSearch();

    expect(definition.kind).toBe("eve:web-search-tool");
    expect(definition).not.toHaveProperty("provider");
    expect(isHarnessOwnedToolDefinition(definition)).toBe(true);
  });
});
