import type { MockModelRequest, MockModelResponse } from "eve/evals";

export const LIFECYCLE_SCENARIO = "Alice coordinates Bob's lifecycle ordering check.";
export const CROSS_TURN_SCENARIO = "Alice launches two pieces of work in separate user turns.";
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };
const COMPLETION = /^Background task task_[a-z0-9]+ \([^)]+\) is completed\./u;

export function lifecycleModel(request: MockModelRequest): MockModelResponse | undefined {
  const setup = request.userMessages.find(
    (message) => message.startsWith(LIFECYCLE_SCENARIO) || message.startsWith(CROSS_TURN_SCENARIO),
  );
  if (setup === undefined) return;
  const key = setup.split(" ").at(-1)!;
  const crossTurn = setup.startsWith(CROSS_TURN_SCENARIO);
  const message =
    [...request.userMessages]
      .reverse()
      .find((entry) => entry.startsWith("Alice ") || COMPLETION.test(entry)) ?? "";
  const result = (id: string) => request.toolResults.find((entry) => entry.id === id);
  const call = (marker: "A" | "B") => ({
    id: `lifecycle-${marker}`,
    name: "lifecycle_task",
    input: { key, marker, child: !crossTurn && marker === "B" },
  });
  const response = (value: Omit<MockModelResponse, "usage">) => ({ ...value, usage: ZERO_USAGE });
  if (message === "Alice checks that Bob's terminal session has no retained handle.") {
    const agents =
      [...request.messages].reverse().find((entry) => entry.text.startsWith("[Agents]"))?.text ??
      "";
    return response({
      text: JSON.stringify([...agents.matchAll(/<agent id="([^"]+)"/gu)].map((match) => match[1])),
    });
  }
  if (COMPLETION.test(message)) {
    // Report only what the runtime actually delivered, without model-side batching.
    const notifications = request.userMessages.filter((entry) => COMPLETION.test(entry));
    return response({ text: JSON.stringify({ report: "LIFECYCLE-REPORT", notifications }) });
  }
  if (message === "Alice keeps the parent active while Bob finishes.") {
    return result("lifecycle-hold") === undefined
      ? response({ toolCalls: [{ id: "lifecycle-hold", name: "lifecycle_hold", input: { key } }] })
      : response({ text: "PARENT-RELEASED" });
  }
  if (message === "Alice checks that the other piece of work is still pending.") {
    return response({ text: "PENDING-CHECK-ACK" });
  }
  if (message === "Alice performs the final metered accounting check.") {
    return { text: "ACCOUNTING-CHECK", usage: { inputTokens: 999_790, outputTokens: 0 } };
  }
  if (message === "Alice checks the remaining session budget.") {
    return response({ text: "B-USAGE-WAS-NOT-ACCUMULATED" });
  }
  if (message === "Alice confirms that all completion deliveries have been observed.") {
    return response({ text: "DRAIN-ACK" });
  }
  const markers: ("A" | "B")[] = crossTurn
    ? [request.userMessages.includes("Alice now launches the second piece of work.") ? "B" : "A"]
    : ["A", "B"];
  const pending = markers.filter((marker) => result(`lifecycle-${marker}`) === undefined);
  return response(
    pending.length > 0
      ? { toolCalls: pending.map(call) }
      : { text: `LAUNCHED:${markers.join(",")}` },
  );
}
