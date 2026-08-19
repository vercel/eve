import { afterEach, describe, expect, it } from "vitest";

import { FALLBACK_SELF_MODIFICATION_MODEL, defineSelfModificationAgent } from "./agent.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("defineSelfModificationAgent", () => {
  it("uses the configured model", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent({ model: "openai/gpt-5" });
    const definition = await agent.events["session.started"]?.({}, {
      model: { id: "anthropic/claude-opus-4.6" },
    } as never);

    expect(definition).toMatchObject({ model: "openai/gpt-5" });
  });

  it("uses the parent model when no model is configured", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent();
    const definition = await agent.events["session.started"]?.({}, {
      model: { id: "anthropic/claude-opus-4.6" },
    } as never);

    expect(definition).toMatchObject({ model: "anthropic/claude-opus-4.6" });
  });

  it("uses the fallback model when no model is configured and no parent model resolves", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent();
    const definition = await agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: FALLBACK_SELF_MODIFICATION_MODEL });
  });
});
