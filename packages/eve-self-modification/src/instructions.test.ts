import { afterEach, describe, expect, it } from "vitest";

import instructions from "../extension/instructions.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
});

describe("self-modification instructions", () => {
  it("keeps registry discovery guidance in development", async () => {
    process.env.EVE_DEV = "1";

    const definition = await instructions.events["session.started"]?.({}, {} as never);

    expect(definition?.markdown).toContain("call selfmod__search_registry");
  });
});
