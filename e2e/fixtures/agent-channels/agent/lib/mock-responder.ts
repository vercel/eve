import type { MockModelRequest, MockModelResponse } from "eve/evals";

const HANDOFF = /^HANDOFF-(TOOL|WORKFLOW|DELEGATED) (\S+)/u;

/**
 * `HANDOFF-TOOL <ref>` and `HANDOFF-WORKFLOW <ref>` call the matching hand-off tool, then reply
 * with its result. `HANDOFF-DELEGATED <ref>` asks the root copy to call `hand_off`, then replies
 * with the copy's result. Anything else echoes, or recalls the latest reply for a code word.
 */
export function respond(request: MockModelRequest): MockModelResponse | string {
  const handOff = [...request.userMessages]
    .reverse()
    .map((message) => HANDOFF.exec(message.replace(/^[\s\S]*Caller message:\s*/u, "")))
    .find((match) => match !== null);
  if (handOff != null) return respondToHandOff(request, handOff[1]!, handOff[2]!);
  const { lastUserMessage, messages } = request;
  return lastUserMessage?.includes("code word")
    ? `Mock reply: ${[...messages].reverse().find((message) => message.role === "assistant")?.text ?? ""}`
    : `Mock reply: ${lastUserMessage ?? ""}`;
}

function respondToHandOff(
  request: MockModelRequest,
  mode: string,
  sessionRef: string,
): MockModelResponse | string {
  if (mode === "DELEGATED") {
    // The root copy answers in a <task_result> once eve__task_wait returns.
    const taskResult = request.messages.find(
      (message) => message.role === "user" && message.text.startsWith("<task_result"),
    );
    if (taskResult !== undefined) return `HANDOFF-RESULT ${taskResult.text}`;
    if (request.toolResults.some((entry) => entry.name === "agent")) {
      return { toolCalls: [{ name: "eve__task_wait", input: {} }] };
    }
    return {
      toolCalls: [{ name: "agent", input: { message: `HANDOFF-TOOL ${sessionRef}` } }],
    };
  }
  const tool = mode === "TOOL" ? "hand_off" : "hand_off_workflow";
  const result = request.toolResults.find((entry) => entry.name === tool);
  if (result === undefined) return { toolCalls: [{ name: tool, input: { sessionRef } }] };
  return `HANDOFF-RESULT ${JSON.stringify(result.output ?? null)}`;
}
