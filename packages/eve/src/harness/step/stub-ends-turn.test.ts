import { describe, expect, it } from "vitest";
import {
  createTask,
  readTaskTable,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { createUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";
import { recordEndingStubCalls } from "#tool-stubs/ending-calls.js";
import { stubTurnEnd } from "./stub-ends-turn.js";

const TURN = "turn_0";

/** A session whose last step made `calls`, each answered, `ending` of them with `endsTurn`. */
function sessionAfter(
  calls: readonly string[],
  options: {
    readonly ending?: readonly string[];
    readonly outputSchema?: HarnessSession["outputSchema"];
    readonly task?: string;
  } = {},
): HarnessSession {
  const history: HarnessModelMessage[] = [
    createUserMessage("user", "Do it."),
    {
      content: calls.map((toolCallId) => ({
        input: {},
        toolCallId,
        toolName: toolCallId,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
    {
      content: calls.map((toolCallId) => ({
        output: { type: "text" as const, value: "done" },
        toolCallId,
        toolName: toolCallId,
        type: "tool-result" as const,
      })),
      role: "tool",
    },
  ];
  let session: HarnessSession = recordEndingStubCalls(
    { history, outputSchema: options.outputSchema } as HarnessSession,
    TURN,
    options.ending ?? calls,
  );
  if (options.task !== undefined) {
    const created = createTask(readTaskTable(session.state), {
      callId: options.task,
      kind: "agent",
      name: options.task,
      resumable: true,
      turnId: TURN,
    });
    session = writeTaskTable(session, created.table);
  }
  return session;
}

const noEndsTurnTools = () => false;

describe("stubTurnEnd", () => {
  it("counts a call to an endsTurn tool beside the ending calls", () => {
    expect(
      stubTurnEnd(
        sessionAfter(["a", "react"], { ending: ["a"] }),
        TURN,
        (name) => name === "react",
      ),
    ).toEqual({ kind: "settle" });
  });

  it("lets the model run while a task no ending call started has a result to read", () => {
    let session = sessionAfter(["a"]);
    const created = createTask(readTaskTable(session.state), {
      callId: "earlier",
      kind: "tool",
      name: "build",
      resumable: false,
      turnId: TURN,
    });
    session = writeTaskTable(
      session,
      settleTaskCalls(created.table, {
        callIds: ["earlier"],
        outcome: { output: "built", status: "completed" },
        taskId: created.taskId,
      }).table,
    );
    expect(stubTurnEnd(session, TURN, noEndsTurnTools)).toBeUndefined();
  });

  it("settles the turn when every call of the last step got an endsTurn response", () => {
    expect(stubTurnEnd(sessionAfter(["a", "b"]), TURN, noEndsTurnTools)).toEqual({
      kind: "settle",
    });
  });

  it("waits for a task an ending call started instead of having the model read its receipt", () => {
    expect(
      stubTurnEnd(sessionAfter(["researcher"], { task: "researcher" }), TURN, noEndsTurnTools),
    ).toEqual({
      kind: "wait",
      taskIds: [expect.any(String)],
    });
  });

  it.each([
    { name: "a call in the step didn't get an endsTurn response", ending: ["a"] },
    { name: "the turn requests structured output", outputSchema: { type: "object" } },
  ])("lets the model run when $name", ({ ending, outputSchema }) => {
    expect(
      stubTurnEnd(
        sessionAfter(["a", "b"], {
          ending,
          outputSchema: outputSchema as HarnessSession["outputSchema"],
        }),
        TURN,
        noEndsTurnTools,
      ),
    ).toBeUndefined();
  });

  it("lets the model run when the ending calls belong to an earlier turn", () => {
    expect(stubTurnEnd(sessionAfter(["a"]), "turn_1", noEndsTurnTools)).toBeUndefined();
  });
});
