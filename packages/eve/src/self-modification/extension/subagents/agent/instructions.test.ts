import { describe, expect, it } from "vitest";

import instructions from "./instructions.js";

describe("self-modification subagent instructions", () => {
  it("handles a bundled mount that is not visible until the next turn", () => {
    const originalEveDev = process.env.EVE_DEV;
    process.env.EVE_DEV = "1";
    try {
      const resolved = instructions.events["session.started"]?.({ data: {} }, {} as never);

      expect(resolved).toMatchObject({
        markdown: expect.stringContaining(
          "first call registry_add with the exact address eve/self-modification",
        ),
      });
      expect(resolved).toMatchObject({
        markdown: expect.stringContaining("Check /source/extensions/self-modification.ts"),
      });
    } finally {
      if (originalEveDev === undefined) delete process.env.EVE_DEV;
      else process.env.EVE_DEV = originalEveDev;
    }
  });
});
