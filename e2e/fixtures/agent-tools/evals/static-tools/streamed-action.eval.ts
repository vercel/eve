import type { ActionResultStreamEvent, HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "streamed-action";
const LABEL = "streaming-e2e";

function streamedBeforeLocalExecutionCompletes(
  events: readonly HandleMessageStreamEvent[],
): boolean {
  const matchingRequests = events.flatMap((event) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions
      .filter((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME)
      .map((action) => ({ action, event }));
  });
  const [request] = matchingRequests;
  if (
    request === undefined ||
    matchingRequests.length !== 1 ||
    request.action.kind !== "tool-call"
  ) {
    return false;
  }

  const result = events.find(
    (event): event is ActionResultStreamEvent =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.callId === request.action.callId,
  );
  if (result === undefined) {
    return false;
  }

  const requestAt = parseTimestamp(request.event.meta?.at);
  const executionCompletedAt = readExecutionCompletedAt(result.data.result.output);
  return (
    requestAt !== undefined &&
    executionCompletedAt !== undefined &&
    requestAt < executionCompletedAt
  );
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readExecutionCompletedAt(output: unknown): number | undefined {
  if (
    typeof output !== "object" ||
    output === null ||
    Array.isArray(output) ||
    !("executionCompletedAt" in output)
  ) {
    return undefined;
  }

  const executionCompletedAt = output.executionCompletedAt;
  return typeof executionCompletedAt === "number" && Number.isFinite(executionCompletedAt)
    ? executionCompletedAt
    : undefined;
}

// The AI SDK can begin local execution just before its tool-call stream part is
// consumed. The tool waits before completing, so post-execution batch emission
// still cannot satisfy this relation.
export default defineEval({
  description: "Static tools smoke: a local action request streams while execution is pending.",
  async test(t) {
    const turn = await t.send(
      `Call the \`${TOOL_NAME}\` tool exactly once with label "${LABEL}". ` +
        "After it returns, reply with the label verbatim.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledTool(TOOL_NAME, {
      input: { label: LABEL },
      count: 1,
    });
    turn.eventsSatisfy(
      "local action request precedes execution completion",
      streamedBeforeLocalExecutionCompletes,
    );
  },
});
