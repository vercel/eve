import { describe, expect, it } from "vitest";

import { deriveTaskId } from "#tasks/ids.js";

const input = { callId: "call_1", name: "researcher", ownerId: "session_1", turnId: "turn_0" };

describe("deriveTaskId", () => {
  it("derives a stable <name>-<6 base32> id from the owner, turn, and call", () => {
    const id = deriveTaskId(input);

    expect(id).toMatch(/^researcher-[0-9a-hjkmnp-tv-z]{6}$/);
    expect(deriveTaskId(input)).toBe(id);
    expect(deriveTaskId({ ...input, callId: "call_2" })).not.toBe(id);
  });

  it("normalizes names into a readable prefix", () => {
    expect(deriveTaskId({ ...input, name: "crm__Deal Review!" })).toMatch(/^crm__deal_review-/);
    expect(deriveTaskId({ ...input, name: "!!!" })).toMatch(/^task-/);
  });

  it("resolves a collision deterministically", () => {
    const first = deriveTaskId(input);
    const second = deriveTaskId({ ...input, taken: (id) => id === first });

    expect(second).not.toBe(first);
    expect(deriveTaskId({ ...input, taken: (id) => id === first })).toBe(second);
  });
});
