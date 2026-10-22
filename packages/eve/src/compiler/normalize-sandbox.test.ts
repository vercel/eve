import { describe, expect, it } from "vitest";
import { defineParentSandbox, defineSandbox } from "#public/definitions/sandbox.js";
import { defineLegacySandboxProvider } from "#shared/sandbox-provider.js";

const provider = defineLegacySandboxProvider({
  name: "test",
  environment: () => ({
    async onSessionEnd() {},
    async prepare() {
      return null;
    },
    async resume() {
      throw new Error("unused");
    },
    async start() {
      throw new Error("unused");
    },
  }),
});

describe("sandbox definitions", () => {
  it("marks selectors", () => {
    const environment = provider.environment();
    expect(
      Reflect.get(
        defineSandbox(() => environment.open()),
        Symbol.for("eve.sandbox-selector"),
      ),
    ).toBe(true);
  });
  it("marks parent selection", () => {
    expect(Reflect.get(defineParentSandbox(), Symbol.for("eve.sandbox-parent-definition"))).toBe(
      true,
    );
  });
});
