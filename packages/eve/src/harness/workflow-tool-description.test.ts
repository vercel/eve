import { describe, expect, it } from "vitest";

import { workflowToolDescription } from "#harness/workflow-tool-description.js";

describe("workflowToolDescription", () => {
  it("explains when orchestration is and is not appropriate", () => {
    const description = workflowToolDescription(["agent", "researcher"]);

    expect(description).toContain("Use `Workflow` for:");
    expect(description).toContain("Do not use `Workflow` when:");
    expect(description).toContain("map-reduce");
    expect(description).toContain("dependent pipelines");
    expect(description).toContain("one delegation");
    expect(description).toContain("small fixed set");
    expect(description).toContain("ordinary tools");
  });

  it("advertises the default subagent-call budget", () => {
    const description = workflowToolDescription(["agent"]);

    expect(description).toContain("at most 100 agent calls");
    expect(description).toContain("WORKFLOW_SUBAGENT_LIMIT_REACHED");
  });

  it("advertises a configured subagent-call budget", () => {
    const description = workflowToolDescription(["agent"], { maxSubagents: 4 });

    expect(description).toContain("at most 4 agent calls");
  });

  it("names every callable agent and safely formats a hyphenated subagent example", () => {
    const description = workflowToolDescription(["agent", "echo-marker", "stock_price"]);

    expect(description).toContain("`agent`");
    expect(description).toContain("`echo-marker`");
    expect(description).toContain("`stock_price`");
    expect(description).toContain('tools["echo-marker"]({');
    expect(description).not.toContain("tools.echo-marker");
  });

  it("omits the subagent example and demonstrates agent() when only the built-in agent is callable", () => {
    const description = workflowToolDescription(["agent"]);

    expect(description).toContain("`agent`");
    expect(description).toContain("agent({");
    expect(description).not.toContain("researcher");
  });
});
