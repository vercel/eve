import type {
  ActionPartialStreamEvent,
  ActionResultStreamEvent,
  MessageStreamEvent,
} from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "streamed-action";
const LABEL = "streaming-e2e";

function streamedBeforeLocalExecutionCompletes(events: readonly MessageStreamEvent[]): boolean {
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
    (event): event is ActionResultStreamEvent & MessageStreamEvent =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.callId === request.action.callId,
  );
  if (result === undefined) {
    return false;
  }

  const requestAt = parseTimestamp(request.event.meta.at);
  const executionCompletedAt = readExecutionCompletedAt(result.data.result.output);
  return (
    requestAt !== undefined &&
    executionCompletedAt !== undefined &&
    requestAt < executionCompletedAt
  );
}

function streamsPreliminaryToolOutput(events: readonly MessageStreamEvent[]): boolean {
  const matchingRequests = events.flatMap((event) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.filter(
      (action) => action.kind === "tool-call" && action.toolName === TOOL_NAME,
    );
  });
  const [request] = matchingRequests;
  if (request === undefined || matchingRequests.length !== 1 || request.kind !== "tool-call") {
    return false;
  }

  const partialIndex = events.findIndex(
    (event): event is ActionPartialStreamEvent & MessageStreamEvent =>
      event.type === "action.partial" &&
      event.data.result.callId === request.callId &&
      event.data.result.toolName === TOOL_NAME,
  );
  const partial = events[partialIndex];
  const resultIndex = events.findIndex(
    (event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.callId === request.callId,
  );
  return (
    partialIndex !== -1 &&
    partial !== undefined &&
    partial.type === "action.partial" &&
    hasPhase(partial.data.result.output, "waiting") &&
    partialIndex < resultIndex
  );
}

function parseTimestamp(value: string): number | undefined {
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

function hasPhase(output: unknown, phase: string): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "phase" in output &&
    output.phase === phase
  );
}

// The AI SDK can begin local execution just before its tool-call stream part is
// consumed. The tool waits before completing, so post-execution batch emission
// still cannot satisfy this relation.
export default defineEval({
  tags: ["real-model"],
  description:
    "Static tools smoke: a local generator streams preliminary output before its result.",
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
    turn.eventsSatisfy(
      "local generator emits a preliminary tool-output snapshot",
      streamsPreliminaryToolOutput,
    );
  },
});
