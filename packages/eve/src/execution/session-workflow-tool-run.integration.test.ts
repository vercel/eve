import { describe, expect, it } from "vitest";

import { readHitlState } from "#harness/hitl/session-state.js";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applyTaskRunMessageStep } from "#execution/tasks/steps.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { containsEventSequence, filterEventsByType } from "#internal/testing/events.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "support-session",
};

describe("handleWorkflowToolRunMessage", () => {
  it("withdraws a request from a run's agent session once the run ends", async () => {
    // Alice's reviewer task asks her to approve creating an issue, then its
    // run fails before she answers, which also ends the reviewer's session.
    const created = createTask(readTaskTable(undefined), {
      callId: "reviewer-call",
      kind: "agent",
      name: "reviewer",
      resumable: true,
      turnId: "turn_1",
    });
    const table = markTaskRunStarted(
      recordTaskRun(created.table, created.taskId, {
        hookToken: "reviewer-run-control",
        runId: "reviewer-run",
      }),
      created.taskId,
      "reviewer-run",
    ).table;
    const base = createTestSessionState(
      {
        sessionId: "support-session",
      },
      { sequence: 2, stepIndex: 0, turnId: "turn_1" },
    );
    const events: MessageStreamEvent[] = [];
    const decoder = new TextDecoder();
    const cursor = new SessionStateCursor({
      history: [],
      inbox: { claimSessionHooks: async () => {} },
      serializedContext,
      sessionState: {
        ...base,
        snapshot: { session: writeTaskTable(base.snapshot.session, table) },
      },
      sessionWritable: new WritableStream<Uint8Array>({
        write(chunk) {
          events.push(JSON.parse(decoder.decode(chunk)) as MessageStreamEvent);
        },
      }),
    });
    const from: WorkflowToolRunRef = {
      callId: "reviewer-call",
      input: { message: "Review the release notes." },
      runId: "reviewer-run",
      sequence: 2,
      stepIndex: 0,
      taskId: created.taskId,
      toolName: "reviewer",
      turnId: "turn_1",
    };

    const runtime = await createTestRuntime({ agent: { name: "support" } });
    await runtime.run(async () => {
      await handleWorkflowToolRunMessage({
        cursor,
        message: {
          from,
          kind: "request",
          replyTo: "reviewer-session-token",
          request: {
            kind: "input-batch",
            requests: [
              {
                action: {
                  callId: "create-issue-call",
                  input: {},
                  kind: "tool-call",
                  toolName: "create_issue",
                },
                kind: "tool-approval",
                options: [{ id: "approve", label: "Approve" }],
                prompt: "Approve creating the release issue?",
                requestId: "approval-1",
              },
            ],
          },
          requestCoordinates: { sequence: 2, stepIndex: 0, turnId: "turn_1" },
        },
      });
      await cursor.advance((state) =>
        applyTaskRunMessageStep({
          ...state,
          message: {
            from,
            kind: "outcome",
            result: { error: "The reviewer's model call failed.", status: "failed" },
          },
        }),
      );
    });

    expect(
      filterEventsByType(events, "input.resolved").map((event) => event.data.resolutions),
    ).toEqual([[{ kind: "tool-approval", outcome: "cancelled", requestId: "approval-1" }]]);
    expect(
      containsEventSequence(events, ["input.requested", "input.resolved", "task.settled"]),
    ).toBe(true);
    expect(readHitlState(cursor.sessionState.snapshot.session.state).relays.size).toBe(0);
  });
});
