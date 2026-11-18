import { defineAgent, type DefinedAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

// The worker's path is split with quotes so the command that starts it, and
// the `[i]` pattern that looks for it, never match their own command lines.
const START_WORKER = [
  'worker=/workspace/idle-stop-"worker".sh',
  "printf 'while :; do sleep 1; done\\n' > \"$worker\"",
  '(nohup bash "$worker" >/dev/null 2>&1 &)',
  "printf '%s' idle-stop-note-K4D > /workspace/idle-stop-note.txt",
  "sleep 1",
  "grep -qaE '[i]dle-stop-worker' /proc/[0-9]*/cmdline 2>/dev/null && echo 'worker: running' || echo 'worker: missing'",
].join("\n");

const CHECK_WORKER = [
  "grep -qaE '[i]dle-stop-worker' /proc/[0-9]*/cmdline 2>/dev/null && echo 'worker: running' || echo 'worker: gone'",
  'echo "note: $(cat /workspace/idle-stop-note.txt 2>/dev/null)"',
].join("\n");

const agent: DefinedAgent = defineAgent({
  description: "Starts a background worker in its own sandbox, or checks on it in a later turn.",
  // Always scripted: the eval checks what an idle stop leaves in the sandbox, not model planning.
  model: mockModel(respond),
});

export default agent;

function respond(request: MockModelRequest): MockModelResponse | string {
  const checking = request.lastUserMessage?.includes("checks on the worker") === true;
  const id = checking ? "check-worker" : "start-worker";
  const result = request.toolResults.find((entry) => entry.id === id);
  if (result === undefined) {
    return {
      toolCalls: [{ id, input: { command: checking ? CHECK_WORKER : START_WORKER }, name: "bash" }],
    };
  }
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
}
