import type { DynamicResolveContext } from "#dynamic/definition.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineSelfModificationAgent } from "./agent.js";

const context: DynamicResolveContext = {
  channel: { kind: "unknown", metadata: {} },
  messages: [],
  model: null,
  session: { auth: { current: null, initiator: null }, id: "session" },
};

afterEach(() => {
  delete process.env.EVE_DEV;
  vi.restoreAllMocks();
});

describe("retired self-modification agent scaffold", () => {
  it.each(["beforeSession", "beforeTurn"] as const)(
    "resolves to null on %s regardless of options",
    async (eventName) => {
      const agent = defineSelfModificationAgent({
        config: { deployed: { authorize: vi.fn() } },
        model: "provider/model",
        reasoning: "high",
      });

      const result =
        eventName === "beforeSession"
          ? agent.events.beforeSession?.({ type: "session.started", data: {} }, context)
          : agent.events.beforeTurn?.(
              {
                type: "turn.started",
                data: {
                  turnId: "turn-test",
                  cause: { deliveryId: "delivery-test" },
                  follows: null,
                },
              },
              context,
            );
      await expect(result).resolves.toBeNull();
    },
  );

  it("warns once in development across both lifecycle events", async () => {
    process.env.EVE_DEV = "1";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agent = defineSelfModificationAgent();

    await agent.events["beforeSession"]?.({ type: "session.started", data: {} }, context);
    await agent.events["beforeTurn"]?.(
      {
        type: "turn.started",
        data: { turnId: "turn-test", cause: { deliveryId: "delivery-test" }, follows: null },
      },
      context,
    );

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[self-modification/retired-scaffold] The scaffolded self-modification subagent is disabled. Migrate to the new self-modification extension by running `/add eve/self-modification`.",
    );
  });

  it("does not warn in production", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await defineSelfModificationAgent().events["beforeSession"]?.(
      { type: "session.started", data: {} },
      context,
    );
    expect(warning).not.toHaveBeenCalled();
  });
});
