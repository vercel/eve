import { describe, expect, it } from "vitest";

import { endUserId } from "#tracing/eve/end-user.js";

describe("endUserId", () => {
  it("prefers the end user the agent put in its runtime context", () => {
    expect(endUserId({ "enduser.id": "slack:T1:U1" }, { id: "user_2", type: "user" })).toBe(
      "slack:T1:U1",
    );
    expect(endUserId({ enduser: { id: "slack:T1:U1" } }, undefined)).toBe("slack:T1:U1");
  });

  it("falls back to the principal id the trace policy recorded", () => {
    expect(endUserId(undefined, { id: "user_2", type: "user" })).toBe("user_2");
    expect(endUserId({ "enduser.id": "" }, { id: "user_2", type: "user" })).toBe("user_2");
  });

  it("records nothing without either", () => {
    expect(endUserId({ "enduser.id": 42 }, { type: "user" })).toBeUndefined();
    expect(endUserId(undefined, undefined)).toBeUndefined();
  });
});
