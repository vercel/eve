import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// The step.started resolver sees the accumulated message history: the
// second turn's count must exceed the first.
export default defineEval({
  description: "Dynamic tools smoke: step.started resolver sees accumulated message history.",
  async test(t) {
    const first = await t.send(
      "Use the `check_messages` tool with label 'turn1' and tell me the messageCount.",
    );
    first.expectOk();
    const firstOutput = first.expectToolCall("check_messages", { status: "completed" }).output;

    const second = await t.send(
      "Use the `check_messages` tool again with label 'turn2' and tell me the messageCount.",
    );
    const secondOutput = second.expectToolCall("check_messages", { status: "completed" }).output;
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

    t.completed();
    // The accumulated-history property is verified per-turn above
    // (firstCount >= 1, secondCount > firstCount). The model may call the
    // tool more than once in a turn, so assert it was called without error
    // rather than pinning an exact count.
    t.calledTool("check_messages", { status: "completed" });
  },
});

function readMessageCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const count = (value as { messageCount?: unknown }).messageCount;
  return typeof count === "number" ? count : undefined;
}
