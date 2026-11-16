import type { Interaction } from "eve/events";
import { beforeEach, describe, expect, it } from "vitest";

import publishTool from "../../tools/publish_contentful_entry";
import { approvalContext, toolContext } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import { isCallable } from "../values";
import { contentfulPublicationInteractions } from "./publication-input";
import { createCmaFake, link } from "./testing/cma";

const input = {
  entries: [{ entryId: "entry", expectedVersion: 7 }],
  space: "docs",
};
const policy = publishTool.approval;
if (!policy || !("request" in policy) || !isCallable(policy.request)) {
  throw new Error("Publication requires a request policy.");
}
const { request } = policy;
const approval: Interaction = {
  call: { callId: "call-1", input, name: "publish_contentful_entry" },
  interactionId: "approval-1",
  request: { kind: "approval", prompt: "Approve publication?" },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
};
const seed = () =>
  createCmaFake({
    entries: [
      {
        fields: { title: { "en-US": "Example entry" } },
        sys: {
          contentType: link("guide", "ContentType"),
          id: "entry",
          version: 7,
        },
      },
    ],
  });
beforeEach(() => testState.reset());

describe("publication card delivery", () => {
  it("denies delegated page publication but permits an explicit component-only batch", async () => {
    const cma = seed();
    const ctx = approvalContext(input);
    const delegated = {
      ...ctx,
      session: {
        ...ctx.session,
        parent: {
          callId: "parent-call",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "parent-turn", sequence: 1 },
        },
      },
    };
    expect(await request(delegated)).toMatchObject({
      reason: expect.stringContaining("main conversation"),
      type: "denied",
    });
    const entry = cma.entries.get("entry");
    if (!entry) {
      throw new Error("Expected the seeded entry.");
    }
    entry.sys.contentType = link("codeBlock", "ContentType");
    testState.reset();
    expect(await request(delegated)).toBe("not-applicable");
    expect(cma.writes()).toHaveLength(0);
  });
  it("lists the saved scope and checkpoints publication through its delivery callback", async () => {
    const cma = seed();
    expect(await request(approvalContext(input))).toBe("user-approval");
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "not been shown"
    );

    const details = await contentfulPublicationInteractions.details?.(approval);
    expect(JSON.stringify(details?.blocks)).toContain("Example entry");
    expect(cma.writes()).toHaveLength(0);
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "not been shown"
    );
    details?.onPosted?.("card-ts");

    expect(await publishTool.execute(input, toolContext())).toMatchObject({
      complete: true,
    });
    expect(cma.writes()).toHaveLength(1);
  });
});

beforeEach(installTestState);
