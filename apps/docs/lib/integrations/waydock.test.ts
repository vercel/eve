import { describe, expect, it } from "vitest";

import waydock from "../../registry/connections/waydock";

function policyFor(toolName: string) {
  const approval = waydock.approval;
  if (typeof approval !== "function") {
    throw new Error("Waydock requires a per-tool approval policy.");
  }
  return approval({ toolName } as never);
}

describe("Waydock connection approval", () => {
  it("allows documented reads and gates writes and unknown tools", () => {
    expect(policyFor("waydock__waydock_search")).toBe("not-applicable");
    expect(policyFor("waydock__waydock_send_email")).toBe("user-approval");
    expect(policyFor("waydock__future_tool")).toBe("user-approval");
  });
});
