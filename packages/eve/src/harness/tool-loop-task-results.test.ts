import { jsonSchema, type FlexibleSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { mockModel, type MockModelRequest, type MockModelResponder } from "#evals/mock-model.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import {
  renderBackgroundTasksInstruction,
  RESULT_TURN_REPLY_PROMPT,
  TASKS_NOTE_LABEL,
} from "#tasks/render.js";

// These sessions have no agent tools, so the block explains the note itself.
const BACKGROUND_TASKS_INSTRUCTION = renderBackgroundTasksInstruction({ agents: false });
import { encodeTaskCreator, holdTaskResult, readPendingTaskResults } from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import { taskCancel } from "#tools/framework/task-cancel.js";

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};
const BOB: SessionAuthContext = { ...ALICE, principalId: "U-bob" };

const REMIND: HarnessToolDefinition = {
  description: "Remind Alice later.",
  detach: true,
  inputSchema: jsonSchema({ type: "object" }),
  name: "remind",
  toModelOutput: (output) => ({
    type: "text",
    value: `Reminder: ${(output as { note: string }).note}`,
  }),
  workflowId: "workflow//./agent/tools/remind//execute",
};

const TASK_CANCEL: HarnessToolDefinition = {
  description: taskCancel.description,
  inputSchema: taskCancel.inputSchema as FlexibleSchema,
  name: "task_cancel",
  outputSchema: taskCancel.outputSchema as FlexibleSchema,
  workflowId: TASK_CANCEL_WORKFLOW_ID,
};

const CHECK: HarnessToolDefinition = {
  description: "Check the deploy.",
  execute: async () => "green",
  inputSchema: jsonSchema({ type: "object" }),
  name: "check",
};

/** A session holding one settled `remind` result created by `creator`. */
function sessionWithResult(input: {
  readonly creator: SessionAuthContext | null;
  readonly history?: readonly HarnessModelMessage[];
  readonly turnId?: string;
}): HarnessSession {
  const record = createTaskRecord({
    callId: "call-remind",
    creator: encodeTaskCreator({ auth: input.creator }),
    id: "remind-q4x1ze",
    kind: "workflow",
    mode: "background",
    name: "remind",
    status: "completed",
  });
  const base: HarnessSession = {
    agent: { modelReference: { id: "model" }, system: "Test assistant", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "session",
    history: [...(input.history ?? [])],
    sessionId: "session",
    state: taskTableState([record]),
  };
  const held = holdTaskResult(base, record, {
    output: { note: "stand-up at 10" },
    status: "completed",
  });
  return input.turnId === undefined
    ? held
    : setHarnessEmissionState(held, {
        sequence: 0,
        sessionStarted: true,
        stepIndex: 1,
        turnId: input.turnId,
      });
}

async function runStep(input: {
  readonly auth: SessionAuthContext | null;
  readonly mode?: "conversation" | "task";
  readonly respond: MockModelResponder;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools?: readonly HarnessToolDefinition[];
}) {
  const events: UnstampedMessageStreamEvent[] = [];
  const requests: MockModelRequest[] = [];
  const model = mockModel((request) => {
    requests.push(request);
    return input.respond(request);
  });
  const harness = createToolLoopHarness({
    handleEvent: async (event) => {
      events.push(event);
    },
    mode: input.mode ?? "conversation",
    resolveModel: async () => model,
    tools: new Map((input.tools ?? [REMIND]).map((tool) => [tool.name, tool])),
  });
  const ctx = new ContextContainer();
  if (input.auth !== null) ctx.set(AuthKey, input.auth);
  let session = input.session;
  let stepInput = input.stepInput;
  // Follow internal continuations until the turn settles.
  for (let index = 0; index < 5; index += 1) {
    const result = await contextStorage.run(ctx, () => harness(session, stepInput));
    session = result.session;
    stepInput = undefined;
    if (result.next === null || typeof result.next !== "function") {
      return { events, requests, result, session };
    }
  }
  throw new Error("The turn did not settle.");
}

function hasResultMessage(request: MockModelRequest): boolean {
  return request.messages.some(
    (message) => message.role === "user" && message.text.startsWith("<task_result"),
  );
}

function lastUserText(request: MockModelRequest): string | undefined {
  return request.messages.findLast((message) => message.role === "user")?.text;
}

describe("background result delivery in the tool loop", () => {
  it("starts a result turn with one task.result message rendered through toModelOutput", async () => {
    const { events, requests, session } = await runStep({
      auth: ALICE,
      respond: () => "Alice, your reminder: stand-up at 10.",
      session: sessionWithResult({ creator: ALICE }),
      stepInput: { taskResults: true },
    });

    expect(lastUserText(requests[0]!)).toBe(
      '<task_result id="remind-q4x1ze" name="remind" status="completed">\nReminder: stand-up at 10\n</task_result>',
    );
    const resultMessages = session.history.filter(
      (message) => message.role === "user" && message.kind === "task.result",
    );
    expect(resultMessages).toHaveLength(1);
    expect(events).toContainEqual({
      data: expect.objectContaining({ kind: "task.result", taskIds: ["remind-q4x1ze"] }),
      type: "message.received",
    });
    expect(events.map((event) => event.type)).toContain("turn.started");
    // Delivered: the result is no longer held and the record is gone from the table.
    expect(readPendingTaskResults(session.state)).toEqual([]);
    expect(getTaskTable(session).records).toEqual([]);
  });

  it("appends a same-principal result at the next tool-step boundary", async () => {
    const history: HarnessModelMessage[] = [
      createUserMessage("user", "Check the deploy, then remind me."),
      {
        content: [{ input: {}, toolCallId: "call-check", toolName: "check", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: "Deploy is green." },
            toolCallId: "call-check",
            toolName: "check",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const { requests } = await runStep({
      auth: ALICE,
      respond: () => "Deploy is green, and your reminder fired.",
      session: sessionWithResult({ creator: ALICE, history, turnId: "turn_0" }),
    });

    const messages = requests[0]!.messages;
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    const resultIndex = messages.findIndex((message) => message.text.startsWith("<task_result"));
    expect(resultIndex).toBeGreaterThan(toolIndex);
  });

  it("leaves another principal's result for its own turn", async () => {
    const { requests, session } = await runStep({
      auth: BOB,
      respond: () => "Hi Bob.",
      session: sessionWithResult({
        creator: ALICE,
        history: [createUserMessage("user", "Bob here.")],
        turnId: "turn_0",
      }),
    });

    expect(hasResultMessage(requests[0]!)).toBe(false);
    expect(readPendingTaskResults(session.state)).toHaveLength(1);
    // Still undelivered, so the note keeps listing the task.
    expect(
      requests[0]!.messages.some(
        (message) =>
          message.text.startsWith(TASKS_NOTE_LABEL) && message.text.includes("remind-q4x1ze"),
      ),
    ).toBe(true);
  });

  it("asks once for a reply when a result turn ends without one", async () => {
    const { requests, result } = await runStep({
      auth: null,
      respond: (request) =>
        lastUserText(request) === RESULT_TURN_REPLY_PROMPT
          ? "Your reminder fired: stand-up at 10."
          : EMPTY_DELIVERY_SENTINEL,
      session: sessionWithResult({ creator: null }),
      stepInput: { taskResults: true },
    });

    expect(requests).toHaveLength(2);
    expect(result.settledTurn?.output).toBe("Your reminder fired: stand-up at 10.");
  });

  it("keeps a task-mode run open until its background tasks report", async () => {
    const working = createTaskRecord({
      id: "remind-q4x1ze",
      kind: "workflow",
      mode: "background",
      name: "remind",
    });
    const awaiting = await runStep({
      auth: null,
      mode: "task",
      respond: () => "Started the reminder.",
      session: { ...sessionWithResult({ creator: null }), state: taskTableState([working]) },
      stepInput: { message: "Set the reminder." },
    });

    expect(awaiting.result.next).toBeNull();
    expect(awaiting.result.settledTurn?.output).toBe("Started the reminder.");
    expect(awaiting.events.map((event) => event.type)).toContain("turn.completed");
    expect(awaiting.events.map((event) => event.type)).not.toContain("session.completed");

    const finished = await runStep({
      auth: null,
      mode: "task",
      respond: () => "The reminder fired.",
      session: sessionWithResult({ creator: null }),
      stepInput: { taskResults: true },
    });
    expect(finished.result.next).toEqual({ done: true, output: "The reminder fired." });
    expect(finished.events.map((event) => event.type)).toContain("session.completed");
  });

  it("includes the background tasks block in the system prompt for detach: true tools", async () => {
    const withDetach = await runStep({
      auth: null,
      respond: () => "ok",
      session: sessionWithResult({ creator: ALICE }),
      stepInput: { message: "Hello" },
    });
    const without = await runStep({
      auth: null,
      respond: () => "ok",
      session: sessionWithResult({ creator: ALICE }),
      stepInput: { message: "Hello" },
      tools: [],
    });

    const system = (request: MockModelRequest) =>
      request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n");
    expect(system(withDetach.requests[0]!)).toContain(BACKGROUND_TASKS_INSTRUCTION);
    expect(system(without.requests[0]!)).not.toContain(BACKGROUND_TASKS_INSTRUCTION);
    // A user turn never starts with a held result.
    expect(hasResultMessage(withDetach.requests[0]!)).toBe(false);
  });

  it.each([
    ["a detach: true tool", "task" as const, [REMIND, TASK_CANCEL], true],
    [
      "an interactive root session with a workflow tool",
      "conversation" as const,
      [{ ...REMIND, detach: undefined }, TASK_CANCEL],
      true,
    ],
    [
      "a task-mode run without detach: true",
      "task" as const,
      [{ ...REMIND, detach: undefined }, TASK_CANCEL],
      false,
    ],
    ["a session with only plain tools", "conversation" as const, [CHECK, TASK_CANCEL], false],
  ])(
    "advertises task_cancel with the background block for %s",
    async (_label, mode, tools, advertised) => {
      const { requests } = await runStep({
        auth: null,
        mode,
        respond: () => "ok",
        session: { ...sessionWithResult({ creator: null }), state: undefined },
        stepInput: { message: "Hello" },
        tools,
      });

      const names = requests[0]!.tools.map((tool) => tool.name);
      const system = requests[0]!.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n");
      expect(names.includes("task_cancel")).toBe(advertised);
      expect(system.includes(BACKGROUND_TASKS_INSTRUCTION)).toBe(advertised);
    },
  );

  it("commits a task_cancel call for the owner instead of running it in the model step", async () => {
    const working = createTaskRecord({
      id: "remind-q4x1ze",
      kind: "workflow",
      mode: "background",
      name: "remind",
    });
    const { result, session } = await runStep({
      auth: null,
      respond: () => ({
        toolCalls: [
          { id: "call-stop", input: { taskIds: ["remind-q4x1ze"] }, name: "task_cancel" },
        ],
      }),
      session: { ...sessionWithResult({ creator: null }), state: taskTableState([working]) },
      stepInput: { message: "Never mind the reminder." },
      tools: [REMIND, TASK_CANCEL],
    });

    expect(result.next).toBeNull();
    expect(getPendingCoordinationBatch(session.state)?.tasks).toEqual([
      expect.objectContaining({
        callId: "call-stop",
        input: { taskIds: ["remind-q4x1ze"] },
        toolName: "task_cancel",
        workflowId: TASK_CANCEL_WORKFLOW_ID,
      }),
    ]);
    // Only the owner writes the table; the model step leaves the task working.
    expect(getTaskTable(session).records).toEqual([working]);
  });

  it.each([[[]], [[""]], [Array.from({ length: 51 }, (_, index) => `task-${index}`)]])(
    "returns an input error for task_cancel ids %o without deferring the call",
    async (taskIds) => {
      const { requests, session } = await runStep({
        auth: null,
        respond: (request) =>
          request.toolResults.length === 0
            ? { toolCalls: [{ id: "call-stop", input: { taskIds }, name: "task_cancel" }] }
            : "I could not stop it.",
        session: { ...sessionWithResult({ creator: null }), state: undefined },
        stepInput: { message: "Stop the reminder." },
        tools: [REMIND, TASK_CANCEL],
      });

      expect(getPendingCoordinationBatch(session.state)).toBeUndefined();
      expect(requests.at(-1)?.toolResults).toEqual([
        expect.objectContaining({ id: "call-stop", isError: true, name: "task_cancel" }),
      ]);
    },
  );
});
