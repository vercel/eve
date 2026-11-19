import { RETENTION_DEFAULT, RETENTION_ZERO } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { AGENT_WORKFLOW_RETENTION_VALUES } from "#shared/agent-definition.js";

describe("AGENT_WORKFLOW_RETENTION_VALUES drift guard", () => {
  it("matches the values @workflow/world accepts", () => {
    expect([...AGENT_WORKFLOW_RETENTION_VALUES].sort()).toEqual(
      [Number(RETENTION_ZERO), RETENTION_DEFAULT].sort(),
    );
  });
});
