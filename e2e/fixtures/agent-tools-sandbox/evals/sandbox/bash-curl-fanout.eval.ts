import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

import { FANOUT_BARRIER_SERVER_URL } from "./shared";

const BASH_TOOL = "bash";
const MINIMUM_CURL_CALLS = 10;
const REQUESTS = [
  { label: "curl-01", query: "Vercel AI Gateway documentation" },
  { label: "curl-02", query: "Anthropic Claude API documentation" },
  { label: "curl-03", query: "OpenAI API documentation" },
  { label: "curl-04", query: "Node.js fetch documentation" },
  { label: "curl-05", query: "React useEffect documentation" },
  { label: "curl-06", query: "TypeScript handbook generics" },
  { label: "curl-07", query: "MDN Fetch API documentation" },
  { label: "curl-08", query: "GitHub Actions documentation" },
  { label: "curl-09", query: "AWS Lambda documentation" },
  { label: "curl-10", query: "Google Search Central documentation" },
] as const;

interface CurlBarrierResult {
  readonly concurrentCallsAtRelease: number;
  readonly label: string;
  readonly query: string;
}

export default defineEval({
  description: "Sandbox Bash: at least ten curls reach a concurrency barrier.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`${BASH_TOOL}\` tool at least ${MINIMUM_CURL_CALLS} separate times in one tool-use step.`,
        "Run every command below at least once. If you make extra calls, repeat a command below.",
        "Do not combine commands, use a loop, or background a process.",
        ...REQUESTS.map((request) => `${request.label}: \`${commandFor(request)}\``),
        "After all commands return, reply with exactly: curl fanout complete",
      ].join("\n"),
    );
    turn.expectOk();

    t.log(formatCurlFanoutTrace(turn.events));
    turn.calledTool(BASH_TOOL);
    turn.noFailedActions();
    turn.eventsSatisfy("at least ten Bash curls reach the concurrency barrier", (events) =>
      curlCallsReachBarrier({
        barrierSize: MINIMUM_CURL_CALLS,
        events,
        expectedRequests: REQUESTS,
        minimumCalls: MINIMUM_CURL_CALLS,
      }),
    );
  },
});

function commandFor(request: (typeof REQUESTS)[number]): string {
  const url = new URL(FANOUT_BARRIER_SERVER_URL);
  url.searchParams.set("label", request.label);
  url.searchParams.set("q", request.query);

  return `curl -fsS --max-time 30 '${url.href}'`;
}

function curlCallsReachBarrier(input: {
  readonly barrierSize: number;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly expectedRequests: readonly { readonly label: string; readonly query: string }[];
  readonly minimumCalls: number;
}): boolean {
  const results = curlBarrierResults(input.events);
  const expectedQueryByLabel = new Map(
    input.expectedRequests.map((request) => [request.label, request.query]),
  );

  return (
    results.length >= input.minimumCalls &&
    expectedQueryByLabel.size === input.expectedRequests.length &&
    input.expectedRequests.every((request) =>
      results.some((result) => result.label === request.label && result.query === request.query),
    ) &&
    results.every(
      (result) =>
        expectedQueryByLabel.get(result.label) === result.query &&
        result.concurrentCallsAtRelease === input.barrierSize,
    )
  );
}

function curlBarrierResults(
  events: readonly HandleMessageStreamEvent[],
): readonly CurlBarrierResult[] {
  return events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== BASH_TOOL) return [];

    return parseCurlBarrierResult(event.data.result.output);
  });
}

function parseCurlBarrierResult(value: unknown): readonly CurlBarrierResult[] {
  const stdout = readStringField(value, "stdout");
  if (stdout === undefined) return [];

  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line);
    const label = readStringField(parsed, "label");
    const query = readStringField(parsed, "query");
    const concurrentCallsAtRelease = readFiniteNumberField(parsed, "concurrentCallsAtRelease");

    if (label !== undefined && query !== undefined && concurrentCallsAtRelease !== undefined) {
      return [
        {
          concurrentCallsAtRelease,
          label,
          query,
        },
      ];
    }
  }
  return [];
}

function formatCurlFanoutTrace(events: readonly HandleMessageStreamEvent[]): string {
  return JSON.stringify({
    calls: curlBarrierResults(events),
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, field);
}

function readFiniteNumberField(value: unknown, field: string): number | undefined {
  const candidate = readField(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  const candidate = readField(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}
