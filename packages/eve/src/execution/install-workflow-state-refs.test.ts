import { afterEach, describe, expect, it } from "vitest";

import {
  installWorkflowStateRefs,
  workflowStateRefsEnabled,
} from "#execution/install-workflow-state-refs.js";

describe("installWorkflowStateRefs", () => {
  afterEach(() => {
    delete process.env.WORKFLOW_STATE_REFS;
  });

  it("turns state references on by default", () => {
    installWorkflowStateRefs();
    expect(workflowStateRefsEnabled()).toBe(true);
  });

  it("keeps an explicit operator value", () => {
    process.env.WORKFLOW_STATE_REFS = "0";
    installWorkflowStateRefs();
    expect(workflowStateRefsEnabled()).toBe(false);
  });
});
