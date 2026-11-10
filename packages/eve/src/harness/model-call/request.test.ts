import type { SystemModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { modelInstructions } from "./request.js";

const other = { anthropicCache: undefined, gateway: false, provider: "openai" } as const;
const gatewayAuto = { anthropicCache: undefined, gateway: true, provider: "anthropic" } as const;
const direct = (ttl: "5m" | "1h") =>
  ({ anthropicCache: { ttl }, gateway: false, provider: "anthropic" }) as const;

const marker = (ttl: "5m" | "1h") => ({
  anthropic: { cacheControl: { type: "ephemeral", ...(ttl === "1h" && { ttl }) } },
  bedrock: { cachePoint: { type: "default", ...(ttl === "1h" && { ttl }) } },
});

describe("modelInstructions", () => {
  it("sends a lone string as it is without a cache profile", () => {
    expect(modelInstructions({ instructions: "rules", profile: other })).toBe("rules");
  });

  it("puts the 1-hour breakpoint on a lone string", () => {
    expect(
      modelInstructions({
        instructions: "rules",
        profile: direct("1h"),
      }),
    ).toEqual({ role: "system", content: "rules", providerOptions: marker("1h") });
  });

  it("puts the 5-minute breakpoint on a lone string for a direct 5-minute profile", () => {
    expect(
      modelInstructions({
        instructions: "rules",
        profile: direct("5m"),
      }),
    ).toEqual({ role: "system", content: "rules", providerOptions: marker("5m") });
  });

  it("marks the base alone and sends the own parts after it unmarked", () => {
    expect(
      modelInstructions({
        instructions: ["base", "", "own a", "own b"],
        profile: direct("1h"),
      }),
    ).toEqual([
      { role: "system", content: "base", providerOptions: marker("1h") },
      { role: "system", content: "own a\n\nown b" },
    ]);
  });

  it("gives sessions with different own parts the same marked base message", () => {
    const first = modelInstructions({
      instructions: ["base", "channel a"],
      profile: direct("5m"),
    }) as SystemModelMessage[];
    const second = modelInstructions({
      instructions: ["base", "user b", "tasks"],
      profile: direct("5m"),
    }) as SystemModelMessage[];
    expect(first[0]).toEqual(second[0]);
    expect(first[1]).not.toEqual(second[1]);
  });

  it("puts a retry's note ahead of the own parts, after the marked base", () => {
    expect(
      modelInstructions({
        instructions: ["base", "own"],
        profile: direct("1h"),
        extraSystemNote: "note",
      }),
    ).toEqual([
      { role: "system", content: "base", providerOptions: marker("1h") },
      { role: "system", content: "note\n\nown" },
    ]);
  });

  it("sends a note without own parts as the second message", () => {
    expect(
      modelInstructions({
        instructions: "base",
        profile: direct("1h"),
        extraSystemNote: "note",
      }),
    ).toEqual([
      { role: "system", content: "base", providerOptions: marker("1h") },
      { role: "system", content: "note" },
    ]);
  });

  it("sends own parts without a base as one unmarked message", () => {
    expect(modelInstructions({ instructions: ["", "own"], profile: direct("1h") })).toEqual({
      role: "system",
      content: "own",
    });
  });

  it("joins the note, base and own parts into one message without a cache profile", () => {
    expect(
      modelInstructions({
        instructions: ["base", "own"],
        profile: other,
        extraSystemNote: "note",
      }),
    ).toEqual({ role: "system", content: "note\n\nbase\n\nown" });
  });

  it("sends nothing when every part is empty", () => {
    expect(modelInstructions({ instructions: [], profile: other })).toBeUndefined();
    expect(modelInstructions({ instructions: [""], profile: direct("1h") })).toBeUndefined();
  });

  it("splits the base from the own parts on Gateway's automatic caching, with no marker", () => {
    expect(modelInstructions({ instructions: ["base", "own"], profile: gatewayAuto })).toEqual([
      { role: "system", content: "base" },
      { role: "system", content: "own" },
    ]);
  });

  it("sends a lone string as it is on Gateway's automatic caching", () => {
    expect(modelInstructions({ instructions: "rules", profile: gatewayAuto })).toBe("rules");
  });

  it("keeps one message for a Gateway model of another vendor", () => {
    expect(
      modelInstructions({
        instructions: ["base", "own"],
        profile: { anthropicCache: undefined, gateway: true, provider: "openai" },
      }),
    ).toEqual({ role: "system", content: "base\n\nown" });
  });
});
