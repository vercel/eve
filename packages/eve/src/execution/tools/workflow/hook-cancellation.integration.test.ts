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
import { ASK_QUESTION_INPUT_SCHEMA } from "#tools/provided/ask-question.js";
import { executeAskQuestionTool } from "#tools/provided/ask-question-workflow.js";
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
        const alice = {
          attributes: {},
          authenticator: "test",
          principalId: "alice",
          principalType: "user" as const,
          issuer: "test",
        };
        const run = await startSessionOwner(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: 'Run confirm_deploy with service "api"' },
            // A typed answer joins the turn only from the principal that started it.
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                acceptedDeploymentId: "dpl_inline",
                continuationToken: `http:workflow-answer-delivery-${mode}`,
                requestInput: true,
              }),
              "eve.auth": alice,
            },
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
            auth: alice,
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

  it("ignores the session's own part of a delivery whose routed answer a hook cancels", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-guarded-answer-with-note",
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
            continuationToken: "http:workflow-tool-guarded-answer-with-note",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        // Alice answers the deploy question and, in the same delivery, adds a note for the agent.
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          deliveryMetadata: [
            {
              channelKind: "http",
              channelName: "test",
              deliveryId: "delivery-answer",
              payloadIndex: 0,
            },
            {
              channelKind: "http",
              channelName: "test",
              deliveryId: "delivery-note",
              payloadIndex: 1,
            },
          ],
          kind: "deliver",
          payloads: [{ message: "Deploy" }, { message: "Thanks, and please post the summary." }],
        });

        const answered = await stream.nextUntil(
          (event) => event.type === "turn.settled" && event.data.outcome === "cancelled",
        );
        expect(filterEventsByType(answered, "delivery.settled")).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ deliveryId: "delivery-note", outcome: "ignored" }),
          }),
        );
        expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
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

describe("workflow typed answers", () => {
  // #4923: a typed answer is the person's next message, so its hooks and the
  // rest of the turn see the request that sent it, as a steering message does,
  // whatever else its payload carries for the session.
  it.each([
    { extra: {}, label: "text" },
    { extra: { state: { thread: "thread-1" } }, label: "channel-state" },
    { extra: { __eveClientContext: ["Viewing the deploy page."] }, label: "client-context" },
  ])(
    "runs a typed answer's turn under the auth of the request that sent it, with $label",
    async ({ extra, label }) => {
      const asker = {
        attributes: { msg: "asking request" },
        authenticator: "test",
        principalId: "alice",
        principalType: "user" as const,
      };
      const seen: (readonly [string, unknown])[] = [];
      const runtime = await createWorkflowToolRuntime({
        agentName: `workflow-tool-answer-auth-${label}`,
        execute: confirmDeployWorkflow,
        modules: [
          {
            logicalPath: "hooks/observe.ts",
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "delivery.consumed"(event, ctx) {
                    seen.push([event.type, ctx.session.auth.current?.attributes.msg]);
                  },
                  "turn.settled"(event, ctx) {
                    seen.push([event.type, ctx.session.auth.current?.attributes.msg]);
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
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                continuationToken: `http:workflow-tool-answer-auth-${label}`,
                requestInput: true,
              }),
              "eve.auth": asker,
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          await stream.nextTurn();
          seen.length = 0;
          await resumeSessionInbox(sessionCommandHookToken(run.runId), {
            auth: { ...asker, attributes: { msg: "answering request" } },
            delivery: { channelKind: "http", channelName: "test", deliveryId: "delivery-answer" },
            kind: "send",
            payload: { message: "Deploy", ...extra },
          });

          await stream.nextTurn();
          expect(seen.at(-1)).toEqual(["turn.settled", "answering request"]);
          expect(new Set(seen.map(([, msg]) => msg))).toEqual(new Set(["answering request"]));
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  // #4923: a turn's principal is fixed. Another person's typed text must not
  // answer the turn's question; it waits and runs as their own turn.
  it.each([
    {
      answers: { alice: "Deploy", bob: "Cancel" },
      execute: confirmDeployWorkflow,
      inputSchema: undefined,
      message: 'Run confirm_deploy with service "api"',
      output: { approved: true, service: "api" },
      toolName: "confirm_deploy",
    },
    {
      answers: { alice: "us-east", bob: "eu-west" },
      execute: executeAskQuestionTool,
      inputSchema: ASK_QUESTION_INPUT_SCHEMA,
      message: "Run ask_question and ask which region to deploy to.",
      output: { answer: "us-east", status: "answered" },
      toolName: "ask_question",
    },
  ])(
    "keeps another principal's typed answer out of the turn that asked through $toolName",
    async ({ answers, execute, inputSchema, message, output, toolName }) => {
      const alice = {
        attributes: {},
        authenticator: "test",
        principalId: "alice",
        principalType: "user" as const,
      };
      const bob = { ...alice, principalId: "bob" };
      const seen: (readonly [string, unknown])[] = [];
      const runtime = await createWorkflowToolRuntime({
        agentName: `workflow-tool-foreign-answer-${toolName}`,
        execute,
        inputSchema,
        modules: [
          {
            logicalPath: "hooks/observe.ts",
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "delivery.consumed"(event, ctx) {
                    seen.push([event.type, ctx.session.auth.current?.principalId]);
                  },
                  "turn.settled"(event, ctx) {
                    seen.push([event.type, ctx.session.auth.current?.principalId]);
                  },
                },
              }),
            }),
          },
        ],
        toolName,
      });

      await runtime.run(async () => {
        const run = await startSessionOwner(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message },
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                continuationToken: `http:workflow-tool-foreign-answer-${toolName}`,
                requestInput: true,
              }),
              "eve.auth": alice,
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const asked = await stream.nextTurn();
          const callId = filterEventsByType(asked, "call.requested").find(
            (event) => event.data.capability.name === toolName,
          )?.data.callId;
          seen.length = 0;
          const inbox = sessionCommandHookToken(run.runId);
          for (const [auth, text] of [
            [bob, answers.bob],
            [alice, answers.alice],
          ] as const) {
            await resumeSessionInbox(inbox, {
              auth,
              delivery: { channelKind: "http", channelName: "test", deliveryId: auth.principalId },
              kind: "send",
              payload: { message: text },
            });
          }

          const answered = await stream.nextTurn();
          const result = filterEventsByType(answered, "call.settled").find(
            (event) => event.data.callId === callId,
          );
          expect(result?.data.output).toEqual(output);
          await stream.nextTurn();
          expect(seen).toEqual([
            ["delivery.consumed", "alice"],
            ["turn.settled", "alice"],
            ["delivery.consumed", "bob"],
            ["turn.settled", "bob"],
          ]);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );
});
