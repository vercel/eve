import { describe, expect, it } from "vitest";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { hydrateWorkflowReturnValue } from "@workflow/core/serialization";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import { authorizedDeployWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("workflow step authorization", () => {
  it("resolves a user token inside a step", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-step-token",
      execute: authorizedDeployWorkflow,
      toolName: "deploy_service",
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "preauthorized"' },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({
              continuationToken: "http:step-token",
              mode: "conversation",
            }),
            "eve.auth": {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        let text = "";
        for (let i = 0; i < 5 && !text.includes("authenticatedAs"); i++) {
          text += JSON.stringify(await stream.nextTurn());
        }
        expect(text).toContain("authenticatedAs");
        expect(text).toContain("user-1");
        expect(text).not.toContain("secret:");
        expect(text).not.toContain("authorization.required");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it.each(["interactive", "retry"])(
    "parks on its own callback and resumes the step (service=%s)",
    async (service) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-step-auth",
        execute: authorizedDeployWorkflow,
        toolName: "deploy_service",
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: `Run deploy_service with service "${service}"` },
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                continuationToken: "http:step-auth",
                mode: "conversation",
                requestInput: true,
              }),
              "eve.auth": {
                attributes: {},
                authenticator: "test-idp",
                issuer: "test-idp",
                principalId: "user-1",
                principalType: "user",
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = [];
          for (
            let i = 0;
            i < 5 && filterEventsByType(events, "authorization.required").length === 0;
            i++
          )
            events.push(...(await stream.nextTurn()));
          const required = filterEventsByType(events, "authorization.required")[0]!;
          expect(required).toBeDefined();
          const url = new URL(required.data.webhookUrl!);
          const parts = url.pathname.split("/").map(decodeURIComponent);
          const token = parts.at(-1)!;
          expect(token).not.toBe(`${run.runId}:auth`);
          const world = await getWorld();
          const executorRunId = (await world.hooks.getByToken(token)).runId;
          url.searchParams.set("code", "approved");
          await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: "another-attempt", name: required.data.name },
          } as never);
          await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: "another-provider" },
          } as never);
          const response = await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: required.data.name },
          } as never);
          expect(response.status).toBe(200);
          for (let i = 0; i < 6 && !JSON.stringify(events).includes("authenticatedAs"); i++) {
            events.push(...(await stream.nextTurn()));
          }
          expect(
            filterEventsByType(events, "authorization.completed").map(
              (event) => event.data.outcome,
            ),
          ).toEqual(["authorized"]);
          const text = JSON.stringify(events);
          expect(text).toContain("authenticatedAs");
          expect(text).toContain("user-1");
          expect(text).not.toContain("secret:");
          const steps = await world.steps.list({
            runId: executorRunId,
            pagination: { limit: 1000 },
          });
          expect(
            steps.data.filter((step) => step.stepName.endsWith("//planDeployStep")),
          ).toHaveLength(1);
          const attempts = steps.data.filter((step) =>
            step.stepName.endsWith("//authorizedDeployStep:eve-authorization"),
          );
          expect(attempts).toHaveLength(2);
          if (service === "retry") {
            expect(attempts.map((step) => step.attempt).sort()).toEqual([1, 2]);
            const retried = attempts.find((step) => step.attempt === 2)!;
            const marker = getRun(executorRunId).getReadable({
              namespace: `eve.authorization.${retried.stepId}.${required.data.attemptId}`,
            });
            const reader = marker.getReader();
            try {
              expect((await reader.read()).value).toBe(true);
            } finally {
              await reader.cancel();
              reader.releaseLock();
            }
          }
          for (const step of attempts) {
            const output = await hydrateWorkflowReturnValue(step.output, executorRunId, undefined);
            expect(JSON.stringify(output)).not.toContain("secret:");
          }
          const duplicate = await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: required.data.name },
          } as never);
          expect(duplicate.status).toBe(404);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );
});
