import { describe, expect, it } from "vitest";

import { workflowToolDescription } from "#harness/workflow-tool-description.js";

describe("workflowToolDescription", () => {
  it("names every callable agent and shows a subagent example when a subagent exists", () => {
    const description = workflowToolDescription(["agent", "researcher", "stock_price"]);

    expect(description).toContain("`agent`");
    expect(description).toContain("`researcher`");
    expect(description).toContain("`stock_price`");
    // The example calls a declared subagent, not the built-in `agent`.
    expect(description).toContain("researcher({");
  });

  it("omits the subagent example and demonstrates agent() when only the built-in agent is callable", () => {
    const description = workflowToolDescription(["agent"]);

    expect(description).toContain("`agent`");
    expect(description).toContain("agent({");
    expect(description).not.toContain("researcher");
  });
});
