import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { backgroundTaskOf, startProgramOnSleeper } from "./background-program";

/** The id the scripted parent gives its `eve__execute` call; its agent call takes `<id>/1`. */
const PROGRAM_CALL = "work-sleeper";
const AGENT_CALL = `${PROGRAM_CALL}/1`;
/** What the sleeper replies once its work item is complete, which the program returns. */
const RESULT = "CHILD_WORK=The work item is complete.";

export default defineEval({
  description:
    "A message that arrives while an eve__execute program waits on an agent moves the program to the background: the model answers the message while the agent works, then reads the program's result in the same turn.",
  timeoutMs: 120_000,

  async test(t) {
    const { child, parent } = await startProgramOnSleeper(t, {
      prompt:
        "Alice asked the sleeper to finish a work item for her. Please ask the sleeper agent from one program with the message PROGRAM-CHILD-WORK, and return what it replies.",
      tool: "complete-work",
    });

    // The sleeper's `complete-work` call takes ten seconds, so it is still working when Bob writes.
    const note = await parent.session.start(
      "While the sleeper works on that, Bob has a note for the minutes: the planning review moved to room 4B. Please confirm you noted it.",
      { turnPolicy: "steer" },
    );
    const turn = await parent.result();
    await note.result();
    const sleeperTurn = await child.result();
    turn.expectOk();

    const taskId = backgroundTaskOf(turn.events, PROGRAM_CALL);
    // The call that was already running now belongs to the task.
    turn.event("call.started", { count: 1, data: { callId: PROGRAM_CALL, taskId } });
    turn.eventOrder([
      {
        count: 1,
        data: { kind: "tool", name: EXECUTE_TOOL, startedBy: { callId: PROGRAM_CALL } },
        type: "task.started",
      },
      // The scripted model names the task its receipt gave, so the receipt answered the call.
      {
        count: 1,
        data: { kind: "text", value: new RegExp(`room 4B.* continues as task ${taskId}\\.`, "u") },
        type: "content.completed",
      },
      // The sleeper was still working when the model answered Bob.
      {
        count: 1,
        data: { callId: AGENT_CALL, outcome: "completed", output: RESULT },
        type: "call.settled",
      },
      {
        count: 1,
        data: {
          callId: PROGRAM_CALL,
          outcome: "completed",
          output: { calls: { completed: 1 }, result: RESULT },
        },
        type: "call.settled",
      },
      { count: 1, data: { outcome: "completed", taskId }, type: "task.ended" },
      // The scripted model reports the result only from a `<task_result>` message.
      {
        count: 1,
        data: { kind: "text", value: /^The sleeper's program finished: .*CHILD_WORK=/su },
        type: "content.completed",
      },
      { count: 1, data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    turn.eventsSatisfy("the program's call settles in the commit that ends its task", (events) => {
      const settled = events.find(
        (event) => event.type === "call.settled" && event.data.callId === PROGRAM_CALL,
      );
      const ended = events.find((event) => event.type === "task.ended");
      return settled !== undefined && settled.meta.position.line === ended?.meta.position.line;
    });
    // Bob's note joined the turn that runs the program; it did not wait for a turn of its own.
    turn.event("turn.started", { count: 1 });
    // The program's agent call kept the one session it opened.
    turn.event("child.opened", {
      count: 1,
      data: { name: "sleeper", owner: { callId: AGENT_CALL } },
    });
    // Nothing stopped the sleeper: it finished its own turn.
    sleeperTurn.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
