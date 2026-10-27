import type { SessionStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "streamed-action";
const LABEL = "streaming-e2e";

/** The one request for the tool, or undefined when there isn't exactly one. */
function onlyRequest(events: readonly SessionStreamEvent[]) {
  const requests = events.filter(
    (event) => event.type === "call.requested" && event.data.capability.name === TOOL_NAME,
  );
  const [request] = requests;
  return requests.length === 1 && request?.type === "call.requested" ? request : undefined;
}

function streamedBeforeLocalExecutionCompletes(events: readonly SessionStreamEvent[]): boolean {
  const request = onlyRequest(events);
  if (request === undefined) return false;

  const result = events.find(
    (event) => event.type === "call.settled" && event.data.callId === request.data.callId,
  );
  if (result?.type !== "call.settled") return false;

  const requestAt = parseTimestamp(request.meta.at);
  const executionCompletedAt = readExecutionCompletedAt(result.data.output);
  return (
    requestAt !== undefined &&
    executionCompletedAt !== undefined &&
    requestAt < executionCompletedAt
  );
}

function streamsPreliminaryToolOutput(events: readonly SessionStreamEvent[]): boolean {
  const request = onlyRequest(events);
  if (request === undefined) return false;

  const partialIndex = events.findIndex(
    (event) => event.type === "call.progress" && event.data.callId === request.data.callId,
  );
  const partial = events[partialIndex];
  const resultIndex = events.findIndex(
    (event) => event.type === "call.settled" && event.data.callId === request.data.callId,
  );
  return (
    partialIndex !== -1 &&
    partial?.type === "call.progress" &&
    hasPhase(partial.data.output, "waiting") &&
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
