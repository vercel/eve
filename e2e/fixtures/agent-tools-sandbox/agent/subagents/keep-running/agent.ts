import { defineAgent, type DefinedAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

// The job's path is split with quotes so the command that starts it, and the
// `[k]` pattern that looks for it, never match their own command lines. It is
// detached, so `bash` returns as completed and tracks nothing. It writes to its
// log every second and ends itself after 4 minutes.
const START_JOB = [
  'job=/workspace/keep-"running".sh',
  "printf 'for i in $(seq 1 240); do date >> /workspace/keep-running.log; sleep 1; done\\n' > \"$job\"",
  '(nohup bash "$job" >/dev/null 2>&1 &)',
  "sleep 1",
  "grep -qaE '[k]eep-running[.]sh' /proc/[0-9]*/cmdline 2>/dev/null && echo 'job: running' || echo 'job: missing'",
].join("\n");

// Reports whether the job survived, then ends it so the sandbox can stop.
const CHECK_JOB = [
  "grep -qaE '[k]eep-running[.]sh' /proc/[0-9]*/cmdline 2>/dev/null && echo 'job: running' || echo 'job: gone'",
  'for p in /proc/[0-9]*; do grep -qaE \'[k]eep-running[.]sh\' "$p/cmdline" 2>/dev/null && kill "${p#/proc/}" 2>/dev/null; done',
  "true",
].join("\n");

const agent: DefinedAgent = defineAgent({
  description:
    "Starts a detached job in its own sandbox and keeps the sandbox running for it, or checks on it in a later turn.",
  // Always scripted: the eval checks what keeps a sandbox running, not model planning.
  model: mockModel(respond),
});

export default agent;

function respond(request: MockModelRequest): MockModelResponse | string {
  if (request.lastUserMessage?.includes("checks on the job") === true) {
    const checked = request.toolResults.find((entry) => entry.id === "check-job");
    if (checked === undefined)
      return { toolCalls: [{ id: "check-job", input: { command: CHECK_JOB }, name: "bash" }] };
    return textOf(checked.output);
  }
  const started = request.toolResults.find((entry) => entry.id === "start-job");
  if (started === undefined)
    return { toolCalls: [{ id: "start-job", input: { command: START_JOB }, name: "bash" }] };
  const kept = request.toolResults.find((entry) => entry.id === "keep-running");
  if (kept === undefined)
    return { toolCalls: [{ id: "keep-running", input: {}, name: "keep_sandbox_running" }] };
  return `${textOf(started.output)}\n${textOf(kept.output)}`;
}

function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}
