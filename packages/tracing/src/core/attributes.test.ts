import { describe, expect, it } from "vitest";
import { runtimeContextAttributes } from "./attributes.js";

describe("runtime context projection", () => {
  it("retains shared objects under each path while stopping cycles", () => {
    const user = { id: "alice" };
    const input: Record<string, unknown> = { requester: user, assignee: user };
    input.self = input;
    expect(runtimeContextAttributes(input)).toEqual({
      "ai.settings.context.requester.id": "alice",
      "ai.settings.context.assignee.id": "alice",
    });
  });
});
