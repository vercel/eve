import type { MockModelRequest, MockModelResponse, MockModelToolCall } from "eve/evals";

const read = (id: string): MockModelToolCall => ({
  id,
  name: "read-draft",
  input: { draftId: "draft-3494" },
});
const call = (id: string, name: string): MockModelToolCall => ({ id, name, input: {} });

// Each sentence is a user instruction in an eval. Results, rather than a mutable
// call counter, select the next response so durable replay uses the same script.
export function respond(request: MockModelRequest): MockModelResponse {
  const instructions = request.userMessages;
  let message = instructions.at(-1) ?? "";
  const roles = request.messages.map((entry) => entry.role);
  const lastResult = request.toolResults.at(-1);
  if (lastResult && roles.lastIndexOf("tool") > roles.lastIndexOf("user")) {
    // Responding to an older request resumes its instruction. A newer user
    // message in the history does not transfer ownership of that tool result.
    const owner = instructions.find((instruction) => {
      switch (lastResult.id) {
        case "change-a":
          return (
            instruction.startsWith("Prepare change A") ||
            instruction === "Prepare changes A and B together."
          );
        case "change-b-read":
        case "change-b":
          return (
            instruction.startsWith("Prepare change B") ||
            instruction === "Prepare changes A and B together."
          );
        case "authorized-read":
        case "authorized":
          return instruction.startsWith("Prepare an authorized change");
        default:
          return false;
      }
    });
    if (owner !== undefined) message = owner;
  }
  const result = (id: string) => request.toolResults.find((entry) => entry.id === id);
  const run = (calls: MockModelToolCall[], answer: () => string): MockModelResponse => {
    const missing = calls.filter((tool) => result(tool.id!) === undefined);
    return missing.length > 0 ? { toolCalls: missing } : { text: answer() };
  };
  const status = (id: string): string => {
    const output = result(id)?.output;
    if (output === null || typeof output !== "object" || !("status" in output)) {
      throw new Error(`Missing status in tool result ${id}: ${JSON.stringify(output)}`);
    }
    return String(output.status);
  };
  const readStatus = (id: string) => run([read(id)], () => `Draft status: ${status(id)}.`);
  const changeThenRead = (id: string, name: string) => {
    if (result(id) === undefined) return { toolCalls: [call(id, name)] };
    return readStatus(`${id}-read`);
  };
  let response: MockModelResponse;
  switch (message) {
    case "Prepare change A.":
    case "Prepare change A using the remaining budget.":
      response = run([call("change-a", "change-a")], () => "Change A resolved.");
      break;
    case "Prepare change B, then read the draft status.":
      response = changeThenRead("change-b", "change-b");
      break;
    case "Prepare change B, then acknowledge my decision.":
      response = run([call("change-b", "change-b")], () => "Change B resolved.");
      break;
    case "Prepare an authorized change.":
      response = run(
        [call("authorized", "authorized-change")],
        () => "Authorized change resolved.",
      );
      break;
    case "Prepare an authorized change, then read the draft status.":
      response = changeThenRead("authorized", "authorized-change");
      break;
    case "Prepare changes A and B together.":
      response = run(
        [call("change-a", "change-a"), call("change-b", "change-b")],
        () => "Both changes resolved.",
      );
      break;
    case "Read the draft status.":
    case "Read the draft status using the remaining budget.":
      response = readStatus("read");
      break;
    case "Save the draft and report how many times it was written.":
      response = run(
        [call("save", "save-draft")],
        () => `Draft saved: ${JSON.stringify(result("save")!.output)}.`,
      );
      break;
    case "Read and save the draft in parallel.":
      response = run(
        [read("read"), call("save", "save-draft")],
        () =>
          `Draft status: ${status("read")}. Draft saved: ${JSON.stringify(result("save")!.output)}.`,
      );
      break;
    case "Try the unavailable draft store and explain the error.":
      response = run([call("failure", "unavailable-draft")], () => {
        if (!result("failure")!.isError) throw new Error("Expected the draft tool to fail.");
        return `Could not read the draft: ${JSON.stringify(result("failure")!.output)}`;
      });
      break;
    case "Try a numeric draft ID, then correct it and read the status.":
      if (result("invalid") === undefined) {
        response = { toolCalls: [{ id: "invalid", name: "read-draft", input: { draftId: 3494 } }] };
      } else {
        if (!result("invalid")!.isError)
          throw new Error("The numeric draft ID must fail validation.");
        response = run(
          [read("corrected")],
          () =>
            `Draft status: ${status("corrected")}. Validation error: ${JSON.stringify(result("invalid")!.output)}`,
        );
      }
      break;
    case "Read the draft through a workflow.":
      response = run(
        [call("workflow", "workflow-draft")],
        () => `Workflow draft status: ${status("workflow")}.`,
      );
      break;
    case "Prepare change A and read the workflow draft together.":
      response = run(
        [call("change-a", "change-a"), call("workflow", "workflow-draft")],
        () => `Workflow draft status: ${status("workflow")}. Change A resolved.`,
      );
      break;
    case "Look up the draft with the provider and report its status.":
      response = run(
        [read("provider-lookup")],
        () => `Provider draft status: ${status("provider-lookup")}.`,
      );
      break;
    case "Explain what is waiting, without calling any tools.":
      response = { text: "Your changes are waiting for approval." };
      break;
    case "Use the remaining budget to say hello.":
      response = { text: "Hello." };
      break;
    default:
      // The runtime converts a response for an already resolved request into a
      // user message. Only that explicitly recognizable input gets this script.
      if (
        message.startsWith(
          "The user submitted the following response to an earlier interactive prompt.",
        )
      ) {
        response = readStatus("stale-response-read");
        break;
      }
      throw new Error(`Unexpected fixture message: ${message}`);
  }
  return {
    ...response,
    usage: { inputTokens: 1, outputTokens: message.includes("remaining budget") ? 1_000_000 : 1 },
  };
}
