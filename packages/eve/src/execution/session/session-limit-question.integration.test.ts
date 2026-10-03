import { describe, expect, it } from "vitest";

import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";

describe("the turn's budget question", () => {
  it("holds the turn over budget, reads a message sent meanwhile, runs the same turn on Continue, and withdraws the question on cancel", async () => {
    const runtime = await createTestRuntime({
      agent: { limits: { maxInputTokensPerSession: 1 }, name: "budget-question" },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Alice asks for the weekly summary." },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:budget-question",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const send = (payload: Record<string, unknown>) =>
        resumeSessionInbox(sessionCommandHookToken(run.runId), { kind: "send", payload });
      try {
        const first = await stream.nextTurn();
        expect(filterEventsByType(first, "turn.completed")).toHaveLength(1);

        await send({ message: "Alice asks for last week's summary too." });
        const asked = await stream.nextTurn();
        const [requested] = filterEventsByType(asked, "input.requested");
        const request = requested!.data.requests[0]!;
        expect(request).toMatchObject({
          kind: "session-limit",
          options: [{ id: "continue" }, { id: "stop" }],
        });
        expect(filterEventsByType(asked, "message.completed")).toHaveLength(0);
        expect(filterEventsByType(asked, "turn.completed")).toHaveLength(0);
        const turnId = requested!.data.turnId;

        // A message that answers nothing is received in the held turn; the
        // question stays open and is not asked again.
        await send({ message: "Alice adds that the invoices matter most." });
        const meanwhile = await stream.nextTurn();
        expect(filterEventsByType(meanwhile, "message.received")).toMatchObject([
          { data: { turnId } },
        ]);
        expect(filterEventsByType(meanwhile, "input.requested")).toHaveLength(0);
        expect(meanwhile.at(-1)).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });

        await send({ inputResponses: [{ optionId: "continue", requestId: request.requestId }] });
        const granted = await stream.nextTurn();
        expect(filterEventsByType(granted, "input.resolved")).toMatchObject([
          { data: { resolutions: [{ kind: "session-limit", outcome: "answered" }], turnId } },
        ]);
        expect(filterEventsByType(granted, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(granted, "message.completed")).toHaveLength(1);
        expect(filterEventsByType(granted, "turn.completed")).toMatchObject([{ data: { turnId } }]);

        await send({ message: "Alice asks for the monthly summary." });
        const askedAgain = filterEventsByType(await stream.nextTurn(), "input.requested")[0]!.data;
        expect(askedAgain.requests[0]!.requestId).not.toBe(request.requestId);

        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          kind: "cancel",
          turnId: askedAgain.turnId,
        });
        const cancelled = await stream.nextTurn();
        expect(filterEventsByType(cancelled, "input.resolved")).toMatchObject([
          {
            data: {
              resolutions: [{ outcome: "cancelled", requestId: askedAgain.requests[0]!.requestId }],
            },
          },
        ]);
        expect(filterEventsByType(cancelled, "turn.cancelled")).toHaveLength(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
