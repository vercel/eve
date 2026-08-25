import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SELF_MODIFICATION_MODEL, defineSelfModificationAgent } from "./agent.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("defineSelfModificationAgent", () => {
  it("uses the default model", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent();
    const definition = await agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: DEFAULT_SELF_MODIFICATION_MODEL });
  });

  it("configures the subagent model", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent({ model: "openai/gpt-5" });
    const definition = await agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: "openai/gpt-5" });
  });
});
