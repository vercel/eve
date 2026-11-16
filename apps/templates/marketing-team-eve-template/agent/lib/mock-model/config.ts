import { mockModel } from "eve/evals";

/**
 * Whether the agents run on deterministic mock models.
 *
 * @remarks
 * Set by `pnpm eval:offline` (`EVE_MOCK_MODEL=1`) so the offline evals exercise the agents'
 * tools, approvals, memory, and subagent plumbing without calling a model provider. It is a test
 * seam: never set it on a deployment that serves people.
 */
export const MOCK_MODELS = process.env.EVE_MOCK_MODEL === "1";

/**
 * A scripted tool call, sent as the user message of an offline eval.
 */
interface ToolScript {
  /** The input to pass to the tool. Defaults to an empty object. */
  readonly input?: unknown;
  /** The name of the tool to call. */
  readonly tool: string;
}

/**
 * The line eve puts before a caller's brief when it delegates to a specialist.
 */
const CALLER_MESSAGE_MARKER = "Caller message:\n";

/**
 * Parse a user message as a {@link ToolScript}.
 *
 * @remarks
 * A specialist receives its brief wrapped in a delegation preamble that ends with
 * {@link CALLER_MESSAGE_MARKER}, so only the text after the marker is parsed when it is present.
 *
 * @param message - The latest user message, or `null` before the first one.
 * @returns The script when the message is a JSON object naming a `tool`, otherwise `null`.
 */
const parseToolScript = (message: string | null): ToolScript | null => {
  const text = message ?? "";
  const marker = text.lastIndexOf(CALLER_MESSAGE_MARKER);
  const body =
    marker === -1 ? text : text.slice(marker + CALLER_MESSAGE_MARKER.length);
  try {
    const parsed: unknown = JSON.parse(body);
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
 * Mock for every agent, driven by the messages it receives.
 *
 * @remarks
 * A user message that is a JSON object `{ "tool", "input" }` makes it call that tool once with
 * that input; after the tool settles it replies with the tool results as JSON. Any other message
 * is answered with every user message seen so far, which includes the memory eve recalls into
 * the conversation, so an eval can assert on recall.
 *
 * A delegation settles in two steps: the specialist's tool call returns a receipt, and its reply
 * arrives afterwards as a user message. That message follows a tool message and is not a script,
 * so it is answered with the tool results instead of being read as a new request.
 */
export const SCRIPTED_MODEL = mockModel(
  ({ messages, toolResults, userMessages }) => {
    const last = messages.at(-1);
    if (last?.role === "tool") {
      return JSON.stringify(toolResults);
    }
    const script = parseToolScript(last?.text ?? null);
    if (script) {
      return { toolCalls: [{ input: script.input ?? {}, name: script.tool }] };
    }
    return messages.at(-2)?.role === "tool"
      ? JSON.stringify(toolResults)
      : userMessages.join("\n");
  }
);
