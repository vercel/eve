import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const BASH_TOOL = "bash";
const INDEX_COMMAND = "for i in $(seq 1 120); do echo indexed batch $i; sleep 1; done";

interface BashOutput {
  readonly jobId?: string;
  readonly status?: string;
  readonly stdout?: string;
}

export default defineEval({
  description: "Sandbox Bash: a slow command returns running, and eve-job waits on and stops it.",
  // The first bash call waits the full 30-second yield before it reports the job.
  timeoutMs: 150_000,
  async test(t) {
    const turn = await t.send(
      [
        "EVE_SANDBOX_BASH_JOB",
        "Alice is rebuilding a search index that prints one progress line per second for two minutes.",
        `Start it with the \`${BASH_TOOL}\` tool by running: \`${INDEX_COMMAND}\``,
        "The tool will report that the command is still running and give it a job id.",
        "Check its progress once with `eve-job wait <job id> 2`, then stop it with `eve-job stop <job id>`.",
        "After it stops, reply with exactly: index job stopped",
      ].join("\n"),
    );
    turn.expectOk();

    t.log(JSON.stringify(bashOutputs(turn.events)));
    turn.noFailedActions();
    turn.eventsSatisfy("the slow command yields, then eve-job waits on and stops it", (events) =>
      jobWasObservedAndStopped(bashOutputs(events)),
    );
  },
});

function jobWasObservedAndStopped(outputs: readonly BashOutput[]): boolean {
  const started = outputs.find((output) => output.status === "running");
  const jobId = started?.jobId;
  if (jobId === undefined || !started?.stdout?.includes("indexed batch 1")) return false;
  const later = outputs.slice(outputs.indexOf(started) + 1);
  return (
    later.some((output) => output.stdout?.includes(`[eve-job ${jobId}: still running.`)) &&
    later.some((output) => output.stdout?.includes(`[eve-job ${jobId}: stopped`))
  );
}

function bashOutputs(events: readonly MessageStreamEvent[]): readonly BashOutput[] {
  return events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== BASH_TOOL) return [];
    const output = event.data.result.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) return [];
    return [output as BashOutput];
  });
}
