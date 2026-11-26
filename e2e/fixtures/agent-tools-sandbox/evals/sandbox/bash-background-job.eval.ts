import { emptySessionView, foldEvents, calls } from "eve/events";
import type { SessionStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const BASH_TOOL = "bash";
const INDEX_COMMAND = "for i in $(seq 1 180); do echo indexed batch $i; sleep 1; done";

interface BashOutput {
  readonly exitCode?: number;
  readonly status?: string;
  readonly stdout?: string;
}

export default defineEval({
  description:
    "Sandbox Bash: a slow command promotes to a background task, keeps writing its output file, and stops with eve__task_cancel.",
  timeoutMs: 150_000,
  async test(t) {
    const turn = await t.send(
      [
        "EVE_SANDBOX_BASH_JOB",
        "Alice is rebuilding a search index that prints one progress line per second for three minutes.",
        `Start it with the \`${BASH_TOOL}\` tool (without passing \`timeout\`) by running: \`${INDEX_COMMAND}\``,
        "After the foreground wait, it will continue as a background task and report its output directory.",
        "Check its latest progress line once with `tail`, then stop the task with `eve__task_cancel`.",
        "After cancelling the task, reply with exactly: index job stopped",
      ].join("\n"),
    );
    turn.expectOk();

    t.log(JSON.stringify(taskAndBashSummary(turn.events)));
    turn.noFailedCalls();
    turn.eventsSatisfy(
      "the slow command promotes to a bash task, keeps writing output, then stops with eve__task_cancel",
      (events) => jobWasPromotedObservedAndCancelled(events),
    );
  },
});

function jobWasPromotedObservedAndCancelled(events: readonly SessionStreamEvent[]): boolean {
  const startedTask = events.find(
    (event) => event.type === "task.started" && event.data.name === BASH_TOOL,
  );
  const cancelledTask = events.find(
    (event) =>
      event.type === "task.ended" &&
      event.data.outcome === "cancelled" &&
      startedTask?.type === "task.started" &&
      event.data.taskId === startedTask.data.taskId,
  );
  const followUps = bashOutputs(events);
  return (
    startedTask !== undefined &&
    cancelledTask !== undefined &&
    followUps.some(
      (output) => output.status === "completed" && /indexed batch \d+/u.test(output.stdout ?? ""),
    )
  );
}

function taskAndBashSummary(events: readonly SessionStreamEvent[]) {
  return {
    bashOutputs: bashOutputs(events),
    tasks: events.filter((event) => event.type === "task.started" || event.type === "task.ended"),
  };
}

function bashOutputs(events: readonly SessionStreamEvent[]): readonly BashOutput[] {
  const view = foldEvents(emptySessionView(), events);

  return calls(view).flatMap((call) => {
    if (call.name !== BASH_TOOL || call.outcome !== "completed") return [];
    const output = call.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) return [];
    return [output as BashOutput];
  });
}
