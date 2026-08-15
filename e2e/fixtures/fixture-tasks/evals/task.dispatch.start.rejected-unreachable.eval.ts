import { defineTaskEval } from "./task-transition.js";

const CALL_ID = "task-a3-unstartable-worker";

/** A failed remote start never admits its prepared task or child session. */
export default defineTaskEval({
  description:
    "An unreachable remote URL fails dispatch without exposing a receipt, task id, or child session.",
  transition: {
    primary: "task.dispatch.start.rejected-unreachable",
    dimensions: { transport: "remote", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-A3-DISPATCH-START-FAILURE");
    started.expectOk();
    started.messageIncludes("TASK-A3-PARENT-SURVIVED");
    started.calledSubagent("unstartable-worker", {
      callId: CALL_ID,
      childSessionId: undefined,
      count: 1,
      output: { code: "REMOTE_AGENT_START_FAILED" },
      status: "failed",
    });
    started.eventsSatisfy(
      "failed start exposes no task id, receipt, child session, or index admission",
      (events) => {
        const failed = events.flatMap((event) =>
          event.type === "action.result" &&
          event.data.result.kind === "subagent-result" &&
          event.data.result.callId === CALL_ID
            ? [event]
            : [],
        );
        const result = failed[0]?.data.result;
        return (
          failed.length === 1 &&
          failed[0]?.data.status === "failed" &&
          result?.kind === "subagent-result" &&
          result.origin === "dispatch" &&
          isStartFailureWithoutTaskId(result.output) &&
          !events.some(
            (event) =>
              event.type === "subagent.completed" &&
              event.data.callId === CALL_ID &&
              event.data.backgroundTask !== undefined,
          ) &&
          !events.some((event) => event.type === "subagent.called" && event.data.callId === CALL_ID)
        );
      },
    );
  },
});

function isStartFailureWithoutTaskId(output: unknown): boolean {
  return (
    output !== null &&
    typeof output === "object" &&
    Reflect.get(output, "code") === "REMOTE_AGENT_START_FAILED" &&
    !Object.hasOwn(output, "taskId")
  );
}
