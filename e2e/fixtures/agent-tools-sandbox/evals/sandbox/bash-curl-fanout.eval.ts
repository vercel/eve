import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

import { FANOUT_DELAY_SERVER_URL } from "./shared";

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

interface CurlMeasurement {
  readonly label: string;
  readonly query: string;
  readonly serverCompletedAtMs: number;
  readonly serverReceivedAtMs: number;
}

export default defineEval({
  description: "Sandbox Bash: at least ten curls each start before the preceding curl finishes.",
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
    turn.eventsSatisfy(
      "at least ten Bash curls each start before the preceding curl finishes",
      (events) =>
        consecutiveCurlStartsOverlap({
          events,
          expectedRequests: REQUESTS,
          minimumCalls: MINIMUM_CURL_CALLS,
        }),
    );
  },
});

function commandFor(request: (typeof REQUESTS)[number]): string {
  const url = new URL(FANOUT_DELAY_SERVER_URL);
  url.searchParams.set("label", request.label);
  url.searchParams.set("q", request.query);

  return `curl -fsS --max-time 30 '${url.href}'`;
}

function consecutiveCurlStartsOverlap(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly expectedRequests: readonly { readonly label: string; readonly query: string }[];
  readonly minimumCalls: number;
}): boolean {
  const measurements = curlMeasurements(input.events);
  const expectedQueryByLabel = new Map(
    input.expectedRequests.map((request) => [request.label, request.query]),
  );

  return (
    measurements.length >= input.minimumCalls &&
    expectedQueryByLabel.size === input.expectedRequests.length &&
    input.expectedRequests.every((request) =>
      measurements.some(
        (measurement) => measurement.label === request.label && measurement.query === request.query,
      ),
    ) &&
    measurements.every(
      (measurement) =>
        expectedQueryByLabel.get(measurement.label) === measurement.query &&
        measurement.serverReceivedAtMs < measurement.serverCompletedAtMs,
    ) &&
    consecutiveStartsOverlap(measurements)
  );
}

function consecutiveStartsOverlap(measurements: readonly CurlMeasurement[]): boolean {
  // The delay server provides one monotonic clock for every curl request.
  const orderedByStart = [...measurements].sort(
    (left, right) =>
      left.serverReceivedAtMs - right.serverReceivedAtMs || left.label.localeCompare(right.label),
  );

  for (let index = 1; index < orderedByStart.length; index += 1) {
    const previous = orderedByStart[index - 1];
    const current = orderedByStart[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.serverCompletedAtMs <= current.serverReceivedAtMs
    ) {
      return false;
    }
  }
  return true;
}

function curlMeasurements(events: readonly HandleMessageStreamEvent[]): readonly CurlMeasurement[] {
  return events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== BASH_TOOL) return [];

    return parseCurlMeasurement(event.data.result.output);
  });
}

function parseCurlMeasurement(value: unknown): readonly CurlMeasurement[] {
  const stdout = readStringField(value, "stdout");
  if (stdout === undefined) return [];

  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line);
    const label = readStringField(parsed, "label");
    const query = readStringField(parsed, "query");
    const serverReceivedAtMs = readFiniteNumberField(parsed, "receivedAtMs");
    const serverCompletedAtMs = readFiniteNumberField(parsed, "completedAtMs");

    if (
      label !== undefined &&
      query !== undefined &&
      serverReceivedAtMs !== undefined &&
      serverCompletedAtMs !== undefined
    ) {
      return [
        {
          label,
          query,
          serverCompletedAtMs,
          serverReceivedAtMs,
        },
      ];
    }
  }
  return [];
}

function formatCurlFanoutTrace(events: readonly HandleMessageStreamEvent[]): string {
  return JSON.stringify({
    calls: curlMeasurements(events).map((measurement) => ({
      ...measurement,
      serverDurationMs: measurement.serverCompletedAtMs - measurement.serverReceivedAtMs,
    })),
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
