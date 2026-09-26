import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

import { FANOUT_LABELS, FANOUT_REPLY, FANOUT_TOOL_NAME } from "../agent/lib/fanout";

export default defineEval({
  description: "Workflow tools: every tool call in one model step runs concurrently.",
  tags: ["workflow", "tools", "concurrent"],

  async test(t) {
    // The fixture's mock model answers this prompt with all ten calls in a
    // single step, so a serialized executor can never release the barrier.
    const turn = await t.send(`Call \`${FANOUT_TOOL_NAME}\` once for each label.`);
    turn.expectOk();

    t.succeeded();
    t.calledTool(FANOUT_TOOL_NAME, { count: FANOUT_LABELS.length });
    t.messageIncludes(FANOUT_REPLY);
    turn.eventsSatisfy("every labeled call reached the concurrency barrier together", (events) =>
      everyCallReachedBarrier(events),
    );
  },
});

function everyCallReachedBarrier(events: readonly MessageStreamEvent[]): boolean {
  const executions = events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== FANOUT_TOOL_NAME) return [];

    const output = event.data.result.output;
    if (typeof output !== "object" || output === null) return [];
    const { concurrentCallsAtRelease, label } = output as Record<string, unknown>;
    return typeof concurrentCallsAtRelease === "number" && typeof label === "string"
      ? [{ concurrentCallsAtRelease, label }]
      : [];
  });

  return (
    executions.length === FANOUT_LABELS.length &&
    executions.every((execution) => execution.concurrentCallsAtRelease === FANOUT_LABELS.length) &&
    new Set(executions.map((execution) => execution.label)).size === FANOUT_LABELS.length &&
    executions.every((execution) => FANOUT_LABELS.includes(execution.label))
  );
}
