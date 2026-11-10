import { describe, expect, it } from "vitest";

import { modelInstructions } from "./request.js";

const marker = (ttl: "5m" | "1h") => ({
  anthropic: { cacheControl: { type: "ephemeral", ...(ttl === "1h" && { ttl }) } },
  bedrock: { cachePoint: { type: "default", ...(ttl === "1h" && { ttl }) } },
});

describe("modelInstructions", () => {
  it("sends a lone string as it is without a cache profile", () => {
    expect(modelInstructions({ instructions: "rules", anthropicCache: undefined })).toBe("rules");
  });

  it("puts the 1-hour breakpoint on a lone string", () => {
    expect(
      modelInstructions({
        instructions: "rules",
        anthropicCache: { ttl: "1h" },
      }),
    ).toEqual({ role: "system", content: "rules", providerOptions: marker("1h") });
  });

  it("puts the 5-minute breakpoint on a lone string for a direct 5-minute profile", () => {
    expect(
      modelInstructions({
        instructions: "rules",
        anthropicCache: { ttl: "5m" },
      }),
    ).toEqual({ role: "system", content: "rules", providerOptions: marker("5m") });
  });

  it("joins parts and marks the end of the system prompt", () => {
    expect(
      modelInstructions({
        instructions: ["a", "", "b"],
        anthropicCache: { ttl: "1h" },
        extraSystemNote: "note",
      }),
    ).toEqual({ role: "system", content: "note\n\na\n\nb", providerOptions: marker("1h") });
  });
});
