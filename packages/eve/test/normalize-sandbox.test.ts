import { describe, expect, it, vi } from "vitest";

import { normalizeSandboxDefinition } from "../src/internal/authored-definition/sandbox.js";
import { defineSandbox, type Sandbox } from "../src/public/definitions/sandbox.js";

const ERROR_MESSAGE = "Test error";

describe("normalizeSandboxDefinition", () => {
  it("accepts a definition created with defineSandbox without invoking it", () => {
    const implementation = vi.fn(() => ({}) as Sandbox);
    const definition = defineSandbox(implementation);

    expect(normalizeSandboxDefinition(definition, ERROR_MESSAGE)).toBe(definition);
    expect(implementation).not.toHaveBeenCalled();
  });

  it.each([{}, async () => ({}) as Sandbox, null, "vercel"])(
    "rejects an unbranded value",
    (value) => {
      expect(() => normalizeSandboxDefinition(value, ERROR_MESSAGE)).toThrow(
        `${ERROR_MESSAGE} Use defineSandbox((ctx) => sandbox).`,
      );
    },
  );

  it("rejects object-shaped values", () => {
    expect(() =>
      normalizeSandboxDefinition(
        {
          create: async () => ({}) as Sandbox,
        },
        ERROR_MESSAGE,
      ),
    ).toThrow(ERROR_MESSAGE);
  });
});
