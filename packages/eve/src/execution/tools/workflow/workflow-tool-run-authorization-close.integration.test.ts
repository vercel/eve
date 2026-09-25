import { describe, expect, it } from "vitest";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { authorizedDeployWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
  waitForWorkflowToolRunTerminal,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("workflow step authorization failures", () => {
  it.each([
    { background: false, disposition: "denied" },
    { background: false, disposition: "rejected" },
    { background: false, disposition: "cancel" },
    { background: true, disposition: "cancel" },
  ])(
    "closes authorization on $disposition (background=$background)",
    async ({ background, disposition }) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-step-auth-failure",
        background,
        execute: authorizedDeployWorkflow,
        toolName: "deploy_service",
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: `Run deploy_service with service "${disposition}"` },
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                continuationToken: "http:step-auth-failure",
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
          const token = decodeURIComponent(url.pathname.split("/").at(-1)!);
          const world = await getWorld();
          const executorRunId = (await world.hooks.getByToken(token)).runId;
          const params = { token, attemptId: required.data.attemptId!, name: required.data.name };
          if (disposition === "cancel") {
            await resumeSessionInbox(
              sessionCommandHookToken(run.runId),
              background ? { kind: "cancel", tasks: true } : { kind: "cancel", turnId: "turn_0" },
            );
          } else {
            url.searchParams.set("code", disposition === "denied" ? "denied" : "approved");
            expect(
              (await handleConnectionCallbackRequest(new Request(url), { params } as never)).status,
            ).toBe(200);
          }
          if (disposition === "cancel") {
            if (!background) {
              events.push(...(await stream.nextTurn()));
              expect(filterEventsByType(events, "turn.cancelled")).toHaveLength(1);
            }
          } else {
            for (
              let i = 0;
              i < 6 && filterEventsByType(events, "authorization.completed").length === 0;
              i++
            )
              events.push(...(await stream.nextTurn()));
            expect(
              filterEventsByType(events, "authorization.completed").map(
                (event) => event.data.outcome,
              ),
            ).toEqual(["failed"]);
          }
          expect(filterEventsByType(events, "authorization.required")).toHaveLength(1);
          await waitForWorkflowToolRunTerminal(executorRunId);
          expect(
            (await handleConnectionCallbackRequest(new Request(url), { params } as never)).status,
          ).toBe(404);
          expect(JSON.stringify(events)).not.toContain("secret:");
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );
});
