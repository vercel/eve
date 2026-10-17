import { describe, expect, it } from "vitest";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  confirmDeployWorkflow,
  reportingDeployWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { defineHook } from "#public/definitions/hook.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("workflow hook cancellation", () => {
  it.each(["button", "text"] as const)(
    "keeps the %s answer delivery open until the workflow's resumed turn settles",
    async (mode) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: `workflow-answer-delivery-${mode}`,
        execute: confirmDeployWorkflow,
        toolName: "confirm_deploy",
      });
      await runtime.run(async () => {
        const run = await startSessionOwner(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: 'Run confirm_deploy with service "api"' },
            serializedContext: buildWorkflowToolSerializedContext({
              acceptedDeploymentId: "dpl_inline",
              continuationToken: `http:workflow-answer-delivery-${mode}`,
              requestInput: true,
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const asked = await stream.nextTurn();
          const question = filterEventsByType(asked, "interaction.opened").find(
            (event) => event.data.request.kind === "question",
          );
          expect(question).toBeDefined();
          await resumeSessionInbox(sessionCommandHookToken(run.runId), {
            kind: "send",
            auth: {
              attributes: {},
              authenticator: "test",
              principalId: "alice",
              principalType: "user",
              issuer: "test",
            },
            delivery: { channelKind: "http", channelName: "test", deliveryId: "answer-delivery" },
            payload:
              mode === "button"
                ? {
                    answers: [{ interactionId: question!.data.interactionId, optionId: "approve" }],
                  }
                : { message: "Deploy" },
          });
          const answered = await stream.nextUntil(
            (event) =>
              event.type === "delivery.settled" && event.data.deliveryId === "answer-delivery",
          );
          expect(filterEventsByType(answered, "delivery.settled").at(-1)?.data).toMatchObject({
            deliveryId: "answer-delivery",
            outcome: "handled",
            turnId: "turn_0",
          });
          expect(filterEventsByType(answered, "call.settled")).toContainEqual(
            expect.objectContaining({
              data: expect.objectContaining({
                outcome: "completed",
                output: { approved: true, service: "api" },
              }),
            }),
          );
          expect(filterEventsByType(answered, "turn.settled").at(-1)?.data.outcome).toBe(
            "completed",
          );
          expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
        } finally {
          stream.dispose();
          await run.cancel().catch(() => {});
        }
      });
    },
    30_000,
  );

  it("lets a delivery.consumed hook cancel a typed answer before it resolves ctx.ask", async () => {
    const hooksAfterCancel: string[] = [];
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-guarded-answer",
      execute: confirmDeployWorkflow,
      modules: [
        {
          logicalPath: "hooks/guard.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "delivery.consumed"(event, ctx) {
                  if (
                    event.data.parts.some((part) => part.kind === "text" && part.text === "Deploy")
                  )
                    ctx.cancel();
                },
              },
            }),
          }),
        },
        {
          logicalPath: "hooks/observe.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                async "delivery.consumed"(event) {
                  if (
                    !event.data.parts.some((part) => part.kind === "text" && part.text === "Deploy")
                  )
                    return;
                  await Promise.resolve();
                  hooksAfterCancel.push("Deploy");
                },
              },
            }),
          }),
        },
      ],
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-guarded-answer",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const asked = await stream.nextTurn();
        expect(filterEventsByType(asked, "interaction.opened")).toHaveLength(1);
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          delivery: { channelKind: "http", channelName: "test", deliveryId: "delivery-answer" },
          kind: "send",
          payload: { message: "Deploy" },
        });

        const answered = await stream.nextTurn();
        expect(hooksAfterCancel).toEqual(["Deploy"]);
        // The hook rejected the message, so it must not reach the waiting call.
        const outcomes = filterEventsByType(answered, "interaction.settled").flatMap((event) => [
          event.data.outcome,
        ]);
        expect(outcomes).not.toContain("accepted");
        const outputs = filterEventsByType(answered, "call.settled").map(
          (event) => event.data.output,
        );
        expect(outputs).not.toContainEqual({ approved: true, service: "api" });
        expect(filterEventsByType(answered, "turn.settled").at(-1)?.data.outcome).toBe("cancelled");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("lets a call.progress hook cancel the turn waiting on the reporting run", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-guarded-progress",
      execute: reportingDeployWorkflow,
      modules: [
        {
          logicalPath: "hooks/guard.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "call.progress"(_event, ctx) {
                  ctx.cancel();
                },
              },
            }),
          }),
        },
      ],
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-guarded-progress",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const settled = await stream.nextTurn();
        expect(filterEventsByType(settled, "call.progress")).toHaveLength(1);
        // The hook stopped the turn, so the run's return must not reach the model.
        const outputs = filterEventsByType(settled, "call.settled").map(
          (event) => event.data.output,
        );
        expect(outputs).not.toContainEqual({ plan: "plan:api" });
        expect(filterEventsByType(settled, "turn.settled").at(-1)?.data.outcome).toBe("cancelled");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);
});
