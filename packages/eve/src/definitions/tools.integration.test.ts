import { describe, expect, it } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { readFirstTurnReply } from "#internal/testing/events.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { defineDynamic } from "#tools/dynamic.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

describe("dynamic workflow tools", () => {
  it("runs a workflow tool a dynamic resolver returns as a durable run, and projects its result", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "dynamic-workflow-tool" },
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineDynamic(() =>
              defineWorkflowTool({
                description: "Deploy a service for Alice.",
                execute: deployServiceWorkflow,
                inputSchema: {
                  properties: { service: { type: "string" } },
                  required: ["service"],
                  type: "object",
                },
                toModelOutput: (output) => ({
                  type: "text",
                  value: `Projected ${(output as { plan: string }).plan}.`,
                }),
              }),
            ),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:dynamic-workflow-tool",
          }),
        },
      ]);
      // The plan comes from a step of the workflow, which only its run can reach. The result
      // arrives in a later step, which reads the tool again to show it to the model.
      expect(await readFirstTurnReply(run)).toContain("Projected plan:api.");
    });
  }, 60_000);
});
