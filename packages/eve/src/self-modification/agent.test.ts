import type { DynamicResolveContext } from "#dynamic/definition.js";
import { afterEach, describe, expect, it } from "vitest";

import { defineSelfModificationAgent } from "./agent.js";

afterEach(() => {
  delete process.env.EVE_DEV;
});

describe("self-modification agent", () => {
  it("forwards the configured reasoning effort to the subagent", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent({ reasoning: "high" });
    const context: DynamicResolveContext = {
      channel: {},
      messages: [],
      model: null,
      session: {
        auth: { current: null, initiator: null },
        id: "session",
      },
    };

    const resolved = await agent.events["session.started"]?.({}, context);

    expect(resolved).toMatchObject({ reasoning: "high" });
  });

  it("offers repairs and delegates only after confirmation", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent();
    const resolved = await agent.events["session.started"]?.(
      {},
      {
        channel: {},
        messages: [],
        model: null,
        session: { auth: { current: null, initiator: null }, id: "session" },
      },
    );

    expect(resolved).toMatchObject({
      description: expect.stringContaining(
        "If a tool or capability created or changed by this subagent later fails",
      ),
    });
    const description = (resolved as { description: string }).description;
    expect(description).toContain("Do not start the repair until the user confirms.");
    expect(description).toContain(
      "Treat that confirmation as a source-modification request and delegate it immediately",
    );
  });
});
