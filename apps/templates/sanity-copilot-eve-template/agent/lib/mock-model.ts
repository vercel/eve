import { mockModel } from "eve/evals";

/**
 * Whether the agents run on deterministic mock models.
 *
 * @remarks
 * Set by `pnpm eval:offline` (`EVE_MOCK_MODEL=1`) so the offline evals exercise the agent's
 * tools, approvals, memory, and subagent plumbing without calling a model provider. It is a test
 * seam: never set it on a deployment that serves users.
 */
export const MOCK_MODELS = process.env.EVE_MOCK_MODEL === "1";

/**
 * A scripted tool call, sent as the user message of an offline eval.
 */
interface ToolScript {
  readonly input?: unknown;
  readonly tool: string;
}

/**
 * Parse a user message as a {@link ToolScript}.
 *
 * @param message - The latest user message, or `null` before the first one.
 * @returns The script when the message is a JSON object naming a `tool`, otherwise `null`.
 */
const parseToolScript = (message: string | null): ToolScript | null => {
  try {
    const parsed: unknown = JSON.parse(message ?? "");
    return typeof parsed === "object" &&
      parsed !== null &&
      "tool" in parsed &&
      typeof parsed.tool === "string"
      ? (parsed as ToolScript)
      : null;
  } catch {
    return null;
  }
};

/**
 * Mock for the root agent, driven by the eval's messages.
 *
 * @remarks
 * A user message that is a JSON object `{ "tool", "input" }` makes it call that tool once with
 * that input; after the tool settles it replies with the tool results as JSON. Any other message
 * is answered with every user message seen so far, which includes the memory eve recalls into
 * the conversation, so an eval can assert on recall.
 */
export const SCRIPTED_MODEL = mockModel(
  ({ lastUserMessage, messages, toolResults, userMessages }) => {
    if (messages.at(-1)?.role === "tool") {
      return JSON.stringify(toolResults);
    }
    const script = parseToolScript(lastUserMessage);
    return script
      ? { toolCalls: [{ input: script.input ?? {}, name: script.tool }] }
      : userMessages.join("\n");
  }
);

/**
 * Name of the tool eve gives an agent to deliver a turn's structured output.
 */
const STRUCTURED_REPLY_TOOL = "eve__reply";

/**
 * Build a mock for a subagent that answers every turn with one structured result.
 *
 * @param build - Produces the structured result from the message the subagent received.
 * @returns A mock model that delivers the result through eve's structured-reply tool.
 */
export const structuredReplyModel = (build: (message: string) => unknown) =>
  mockModel(({ lastUserMessage, messages }) =>
    messages.at(-1)?.role === "tool"
      ? "Done."
      : {
          toolCalls: [
            {
              input: build(lastUserMessage ?? ""),
              name: STRUCTURED_REPLY_TOOL,
            },
          ],
        }
  );
