import { describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const rest = await importOriginal<typeof import("ai")>();
  return { ...rest, extract: undefined, experimental_extract: undefined };
});

const { extractWithMetadata } = await import("#ai/extraction-adapter.js");

describe("extractWithMetadata", () => {
  it("names the missing AI SDK export instead of failing at import time", () => {
    expect(() =>
      extractWithMetadata({ model: "scaledown/extract-1", state: "Hello", fields: {} }),
    ).toThrow('installed "ai" package that exports extract or experimental_extract');
  });
});
