import { describe, expect, it } from "vitest";

import { mintClearance } from "#harness/clearance.js";
import { admitWorkflowTask, hasWorkflowAdmission } from "#harness/workflow-admission.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

const request: RuntimeWorkflowTaskRequest = {
  callId: "deploy-1",
  entry: { entryPoint: "execute" },
  input: { region: "iad1", service: "api" },
  kind: "workflow-task",
  toolName: "deploy",
  workflowId: "workflow//./agent/tools/deploy//execute",
};

describe("workflow admission", () => {
  it("admits a request the gate cleared", () => {
    expect(hasWorkflowAdmission(admitWorkflowTask(request, mintClearance("deploy-1")))).toBe(true);
  });

  it("still admits the request after a serializer reorders its keys", () => {
    const admitted = admitWorkflowTask(request, mintClearance("deploy-1"));
    const reordered: RuntimeWorkflowTaskRequest = {
      ...admitted,
      entry: { ...admitted.entry },
      input: { service: "api", region: "iad1" },
    };
    expect(hasWorkflowAdmission(reordered)).toBe(true);
  });

  it("refuses a request whose input changed after it was admitted", () => {
    const admitted = admitWorkflowTask(request, mintClearance("deploy-1"));
    expect(hasWorkflowAdmission({ ...admitted, input: { region: "iad1", service: "db" } })).toBe(
      false,
    );
  });

  it("refuses a request that never went through the gate", () => {
    expect(hasWorkflowAdmission(request)).toBe(false);
  });
});
