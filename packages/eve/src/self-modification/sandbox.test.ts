import { describe, expect, it, vi } from "vitest";

import { defineSelfModificationSandbox, selectDeployedSelfModificationBackend } from "./sandbox.js";

describe("retired self-modification sandbox scaffold", () => {
  it("returns an inert sandbox definition", () => {
    const definition = defineSelfModificationSandbox({
      config: { deployed: { authorize: vi.fn() } },
    });
    expect(definition.backend).toBeUndefined();
    expect(definition.onSession).toBeUndefined();
  });

  it("does not select or provision a backend", () => {
    expect(() => selectDeployedSelfModificationBackend(undefined, {})).toThrow(
      "Deployed self-modification is disabled in the retired scaffold.",
    );
  });

  it("preserves explicitly typed options for compatibility", () => {
    expect(() =>
      defineSelfModificationSandbox({
        backend: { name: "just-bash" } as never,
        config: {},
      }),
    ).not.toThrow();
  });
});
