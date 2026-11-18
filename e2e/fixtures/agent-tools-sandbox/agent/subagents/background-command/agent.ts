import { defineAgent, type DefinedAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

// The export's path is split with quotes so the command that starts it, and
// the `[b]` pattern that looks for it, never match their own command lines.
// It runs in the foreground, so `bash` returns it as `running` after a second.
const START_EXPORT = [
  'script=/workspace/background-"export".sh',
  "printf 'while :; do sleep 1; done\\n' > \"$script\"",
  'bash "$script"',
].join("\n");

// Reports whether the export survived, then ends it so the sandbox can stop.
const CHECK_EXPORT = [
  "grep -qaE '[b]ackground-export' /proc/[0-9]*/cmdline 2>/dev/null && echo 'export: running' || echo 'export: gone'",
  'for p in /proc/[0-9]*; do grep -qaE \'[b]ackground-export\' "$p/cmdline" 2>/dev/null && kill "${p#/proc/}" 2>/dev/null; done',
  "true",
].join("\n");

const agent: DefinedAgent = defineAgent({
  description: "Leaves an export running in its own sandbox, or checks on it in a later turn.",
  // Always scripted: the eval checks what keeps a sandbox running, not model planning.
  model: mockModel(respond),
});

export default agent;

function respond(request: MockModelRequest): MockModelResponse | string {
  const checking = request.lastUserMessage?.includes("checks on the export") === true;
  const id = checking ? "check-export" : "start-export";
  const result = request.toolResults.find((entry) => entry.id === id);
  if (result === undefined) {
    return {
      toolCalls: [
        {
          id,
          input: checking ? { command: CHECK_EXPORT } : { command: START_EXPORT, timeout: 1 },
          name: "bash",
        },
      ],
    };
  }
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
}
