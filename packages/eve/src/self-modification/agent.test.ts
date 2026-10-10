import type { ResolveContext as DynamicResolveContext } from "#dynamic/definition.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineSelfModificationAgent } from "./agent.js";

const context: DynamicResolveContext = {
  abortSignal: new AbortController().signal,
  channel: {},
  session: { auth: { current: null, initiator: null }, id: "session" },
};

afterEach(() => {
  delete process.env.EVE_DEV;
  vi.restoreAllMocks();
});

describe("retired self-modification agent scaffold", () => {
  it("resolves to null regardless of options", async () => {
    const agent = defineSelfModificationAgent({
      config: { deployed: { authorize: vi.fn() } },
      model: "provider/model",
      reasoning: "high",
    });

    await expect(agent.resolve(null, context)).resolves.toBeNull();
  });

  it("warns once in development across resolves", async () => {
    process.env.EVE_DEV = "1";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agent = defineSelfModificationAgent();

    await agent.resolve(null, context);
    await agent.resolve(null, context);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[self-modification/retired-scaffold] The scaffolded self-modification subagent is disabled. Migrate to the new self-modification extension by running `/add eve/self-modification`.",
    );
  });

  it("does not warn in production", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await defineSelfModificationAgent().resolve(null, context);
    expect(warning).not.toHaveBeenCalled();
  });
});
