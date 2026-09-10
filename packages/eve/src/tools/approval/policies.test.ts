import { describe, expect, it, vi } from "vitest";

import { always, isNeverApproval, never, once } from "#tools/approval/policies.js";
import { readDurableDynamicCallback } from "#tools/durable-callbacks.js";

describe("dynamic tool approval helpers", () => {
  it("recognizes never across separately loaded copies of eve", async () => {
    const original = never();
    vi.resetModules();
    const separate = await import("#tools/approval/policies.js");
    expect(separate.isNeverApproval(original)).toBe(true);
    expect(isNeverApproval(separate.never())).toBe(true);
    expect(isNeverApproval(separate.always())).toBe(false);
    expect(isNeverApproval(() => "not-applicable")).toBe(false);
  });

  it.each([
    ["always", always(), "user-approval"],
    ["never", never(), "not-applicable"],
  ] as const)("gives %s a stable replay descriptor", async (_name, policy, expected) => {
    const reference = readDurableDynamicCallback(policy);
    expect(reference?.callback).toBeTypeOf("function");
    expect(reference?.closure).toEqual({});

    expect(await reference!.callback(reference!.closure, {} as never)).toBe(expected);
  });

  it("replays once against the current approval context", async () => {
    const reference = readDurableDynamicCallback(once())!;

    expect(
      await reference.callback(reference.closure, {
        approvedTools: new Set(),
        toolName: "guarded",
      } as never),
    ).toBe("user-approval");
    expect(
      await reference.callback(reference.closure, {
        approvedTools: new Set(["guarded"]),
        toolName: "guarded",
      } as never),
    ).toBe("not-applicable");
  });
});
