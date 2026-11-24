import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { CallOutcome } from "#protocol/session-events/families/call.js";
import type { JsonValue } from "#shared/json.js";

export interface InterruptedCall {
  readonly name: string;
  readonly input?: JsonValue;
  readonly started: boolean;
  readonly outcome?: CallOutcome;
  readonly output?: JsonValue;
  readonly error?: string;
}

export function interruptedCallResult(call: InterruptedCall | undefined): string {
  switch (call?.outcome) {
    case "completed":
      return "This call completed, but its result was lost when the step running it was interrupted.";
    case "failed":
      return "This call failed before the step running it was interrupted.";
    case "rejected":
      return "This call was rejected.";
    default:
      return call?.started === true
        ? "The step running this call was interrupted. The call may or may not have taken effect."
        : "This call did not run.";
  }
}

export const MAX_NOTED_CALLS = 20;
const MAX_NOTED_INPUT_LENGTH = 500;

export function interruptedAttemptNote(
  calls: ReadonlyMap<string, InterruptedCall>,
): HarnessModelMessage | undefined {
  const started = [...calls.values()].filter((call) => call.started && call.name !== "");
  if (started.length === 0) return undefined;
  const lines = started.slice(0, MAX_NOTED_CALLS).map((call) => {
    const input =
      call.input === undefined ? "" : ` ${truncateNotedInput(JSON.stringify(call.input))}`;
    return `- ${call.name}${input}: ${interruptedCallResult(call)}`;
  });
  if (started.length > MAX_NOTED_CALLS) {
    lines.push(`- ${started.length - MAX_NOTED_CALLS} more calls.`);
  }
  return createFrameworkUserMessage(
    "execution.retry",
    [
      "An infrastructure failure interrupted your previous attempt at this step before its results were saved. It made these tool calls:",
      ...lines,
      "Before repeating a call that changes anything outside this conversation, check whether it already took effect.",
    ].join("\n"),
  );
}

export function truncateNotedInput(text: string): string {
  return text.length <= MAX_NOTED_INPUT_LENGTH
    ? text
    : `${text.slice(0, MAX_NOTED_INPUT_LENGTH)}… (truncated)`;
}
