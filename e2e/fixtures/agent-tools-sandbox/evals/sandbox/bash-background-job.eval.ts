import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const BASH_TOOL = "bash";
const INDEX_COMMAND = "for i in $(seq 1 120); do echo indexed batch $i; sleep 1; done";

interface BashOutput {
  readonly exitCode?: number;
  readonly status?: string;
  readonly stdout?: string;
}

export default defineEval({
  description:
    "Sandbox Bash: a slow command returns running, keeps writing its output file, and stops with kill.",
  // The first bash call waits the full 30-second yield before it reports the command.
  timeoutMs: 150_000,
  async test(t) {
    const turn = await t.send(
      [
        "EVE_SANDBOX_BASH_JOB",
        "Alice is rebuilding a search index that prints one progress line per second for two minutes.",
        `Start it with the \`${BASH_TOOL}\` tool by running: \`${INDEX_COMMAND}\``,
        "The tool will report that the command is still running, with its process group and output directory.",
        "Check its latest progress line once with `tail`, then stop it with `kill` and read its exit code.",
        "After it stops, reply with exactly: index job stopped",
      ].join("\n"),
    );
    turn.expectOk();

    t.log(JSON.stringify(bashOutputs(turn.events)));
    turn.noFailedActions();
    turn.eventsSatisfy("the slow command yields, keeps running, then stops with kill", (events) =>
      jobWasObservedAndStopped(bashOutputs(events)),
    );
  },
});

/**
 * Models group the follow-up commands differently: `tail`, `kill`, and the exit
 * read may share one call or take three. Every later call must finish, one must
 * show a progress line, and the last one must end with the exit code.
 */
function jobWasObservedAndStopped(outputs: readonly BashOutput[]): boolean {
  const [started, ...followUps] = outputs;
  const exitCode = followUps.at(-1)?.stdout?.trim().split("\n").at(-1);
  return (
    started?.status === "running" &&
    started.stdout?.includes("indexed batch 1") === true &&
    followUps.length > 0 &&
    followUps.every((output) => output.status === "completed") &&
    followUps.some((output) => /indexed batch \d+/u.test(output.stdout ?? "")) &&
    exitCode === "143"
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
