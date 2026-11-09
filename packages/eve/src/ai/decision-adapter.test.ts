import { describe, expect, it, vi } from "vitest";

// Simulates an installed `ai` release that renamed or removed the decision API.
vi.mock("ai", async (importOriginal) => {
  const rest = await importOriginal<typeof import("ai")>();
  // Vitest mocks throw on keys the factory omits; a real ESM namespace returns undefined.
  return { ...rest, decide: undefined, experimental_decide: undefined };
});

const { decideWithMetadata } = await import("#ai/decision-adapter.js");

describe("decideWithMetadata", () => {
  it("names the missing AI SDK export instead of failing at import time", () => {
    expect(() =>
      decideWithMetadata({ model: "typesafe-ai/jev", state: "Hello", questions: {} }),
    ).toThrow('installed "ai" package that exports decide or experimental_decide');
  });
});
