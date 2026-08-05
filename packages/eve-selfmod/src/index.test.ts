import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SELFMOD_MODEL } from "./agent.js";
import { defineSelfmod } from "./index.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("defineSelfmod", () => {
  it("returns the coordinated definitions with the default model", async () => {
    process.env.EVE_DEV = "1";

    const selfmod = defineSelfmod();
    const definition = await selfmod.agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: DEFAULT_SELFMOD_MODEL });
    expect(selfmod.extension).toBeDefined();
    expect(selfmod.sandbox).toBeDefined();
  });

  it("configures the subagent model", async () => {
    process.env.EVE_DEV = "1";

    const selfmod = defineSelfmod({ model: "openai/gpt-5" });
    const definition = await selfmod.agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: "openai/gpt-5" });
  });
});
