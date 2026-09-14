import { afterEach, describe, expect, it } from "vitest";

import { defineSelfModificationAgent } from "./agent.js";

const originalEveDev = process.env.EVE_DEV;

afterEach(() => {
  if (originalEveDev === undefined) delete process.env.EVE_DEV;
  else process.env.EVE_DEV = originalEveDev;
});

describe("defineSelfModificationAgent", () => {
  it("tells the parent to offer, but not automatically start, repairs", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent();
    const resolved = await agent.events["session.started"]?.(
      {},
      {
        channel: {},
        messages: [],
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(resolved).toMatchObject({
      description: expect.stringContaining(
        "If a change made by this subagent later fails or behaves incorrectly",
      ),
    });
    expect((resolved as { description: string }).description).toContain(
      "Do not start the repair without user confirmation.",
    );
  });
});
