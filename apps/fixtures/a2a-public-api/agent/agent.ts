import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  modelContextWindowTokens: 100_000,
  model: mockModel((request) => {
    const message =
      request.userMessages.find((value) => /^(DELEGATE |REMOTE |CALL )/.test(value)) ??
      request.lastUserMessage ??
      "";
    const result = request.toolResults.at(-1);
    if (message.startsWith("DELEGATE ")) {
      if (!result)
        return {
          toolCalls: [{ name: "a2a_delegate", input: { message: `REMOTE ${message.slice(9)}` } }],
        };
      return `PARENT ${request.lastUserMessage ?? ""} ${JSON.stringify(result.output)}`;
    }
    if (message.startsWith("CALL ")) {
      if (result) return JSON.stringify(result.output);
      const command = JSON.parse(message.slice(5));
      return { toolCalls: [{ name: command.tool, input: command.input }] };
    }
    if (message === "REMOTE ask") {
      return result
        ? `City: ${JSON.stringify(result.output)}`
        : { toolCalls: [{ name: "demo_job", input: { kind: "ask" } }] };
    }
    const wait = /^REMOTE wait (\d+)$/.exec(message);
    if (wait)
      return result
        ? `Finished: ${JSON.stringify(result.output)}`
        : { toolCalls: [{ name: "demo_job", input: { kind: "wait", seconds: Number(wait[1]) } }] };
    return `Echo: ${message.replace(/^REMOTE /, "")}`;
  }),
});
