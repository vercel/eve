import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// An authored tool reads the step's model input from ctx.messages: it includes
// the message that led to the call and accumulates across turns.
export default defineEval({
  description: "Authored tools see the step's messages, including the current turn's input.",
  async test(t) {
    const first = await t.send(
      "Call the `context_messages` tool to check what it can see about the first request.",
    );
    first.expectOk();
    const firstOutput = first.requireToolCall("context_messages").output;

    const second = await first.session.send(
      "Call the `context_messages` tool again for the follow-up about the blue invoice.",
    );
    second.expectOk();
    const secondOutput = second.requireToolCall("context_messages").output;

    t.check(
      secondOutput,
      satisfies(
        (value) => readLastUserText(value)?.includes("blue invoice") === true,
        "the tool sees the message that requested the call",
      ),
    );
    t.check(
      [firstOutput, secondOutput],
      satisfies(([firstValue, secondValue]: readonly unknown[]) => {
        const firstCount = readMessageCount(firstValue);
        const secondCount = readMessageCount(secondValue);
        return (
          firstCount !== undefined &&
          secondCount !== undefined &&
          firstCount >= 1 &&
          secondCount > firstCount
        );
      }, "message count increases across turns"),
    );
    t.succeeded();
  },
});

function readMessageCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const count = (value as { messageCount?: unknown }).messageCount;
  return typeof count === "number" ? count : undefined;
}

function readLastUserText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const text = (value as { lastUserText?: unknown }).lastUserText;
  return typeof text === "string" ? text : undefined;
}
