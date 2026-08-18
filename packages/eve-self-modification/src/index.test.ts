import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SELF_MODIFICATION_MODEL } from "./agent.js";
import { defineSelfModification } from "./index.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("defineSelfModification", () => {
  it("returns the coordinated definitions with the default model", async () => {
    process.env.EVE_DEV = "1";

    const selfModification = defineSelfModification();
    const definition = await selfModification.agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: DEFAULT_SELF_MODIFICATION_MODEL });
    expect(selfModification.extension).toBeDefined();
    expect(selfModification.sandbox).toBeDefined();
  });

  it("configures the subagent model", async () => {
    process.env.EVE_DEV = "1";

    const selfModification = defineSelfModification({ model: "openai/gpt-5" });
    const definition = await selfModification.agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: "openai/gpt-5" });
  });
});
