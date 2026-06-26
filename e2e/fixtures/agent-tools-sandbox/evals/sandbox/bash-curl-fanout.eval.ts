import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

import { FANOUT_DELAY_SERVER_URL } from "./shared.js";

const BASH_TOOL = "bash";
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
  readonly clientCompletedAtMs: number;
  readonly clientStartedAtMs: number;
  readonly label: string;
  readonly query: string;
  readonly serverCompletedAtMs: number;
  readonly serverReceivedAtMs: number;
}

export default defineEval({
  description: "Sandbox Bash: each curl starts before the previous curl finishes.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`${BASH_TOOL}\` tool exactly ${REQUESTS.length} separate times in one tool-use step.`,
        "Run each command below exactly once. Do not combine commands, use a loop, or background a process.",
        ...REQUESTS.map((request) => `${request.label}: \`${commandFor(request)}\``),
        "After all commands return, reply with exactly: curl fanout complete",
      ].join("\n"),
    );
    turn.expectOk();

    t.log(formatCurlFanoutTrace(turn.events));
    turn.calledTool(BASH_TOOL, { count: REQUESTS.length });
    turn.noFailedActions();
    turn.eventsSatisfy("each Bash curl starts before the previous curl finishes", (events) =>
      consecutiveCurlStartsOverlap({ events, expectedRequests: REQUESTS }),
    );
  },
});

function commandFor(request: (typeof REQUESTS)[number]): string {
  const url = new URL(FANOUT_DELAY_SERVER_URL);
  url.searchParams.set("label", request.label);
  url.searchParams.set("q", request.query);

  return [
    "started=$(date +%s%3N)",
    `response=$(curl -fsS --max-time 30 '${url.href}')`,
    "completed=$(date +%s%3N)",
    'printf \'{"clientStartedAtMs":%s,"clientCompletedAtMs":%s,"server":%s}\\n\' "$started" "$completed" "$response"',
  ].join("; ");
}

function consecutiveCurlStartsOverlap(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly expectedRequests: readonly { readonly label: string; readonly query: string }[];
}): boolean {
  const measurements = curlMeasurements(input.events);
  const expectedQueryByLabel = new Map(
    input.expectedRequests.map((request) => [request.label, request.query]),
  );

  return (
    measurements.length === input.expectedRequests.length &&
    expectedQueryByLabel.size === input.expectedRequests.length &&
    new Set(measurements.map((measurement) => measurement.label)).size ===
      input.expectedRequests.length &&
    measurements.every(
      (measurement) =>
        expectedQueryByLabel.get(measurement.label) === measurement.query &&
        measurement.clientStartedAtMs < measurement.clientCompletedAtMs &&
        measurement.serverReceivedAtMs < measurement.serverCompletedAtMs,
    ) &&
    consecutiveStartsOverlap(measurements)
  );
}

function consecutiveStartsOverlap(measurements: readonly CurlMeasurement[]): boolean {
  const orderedByStart = [...measurements].sort(
    (left, right) =>
      left.clientStartedAtMs - right.clientStartedAtMs || left.label.localeCompare(right.label),
  );

  for (let index = 1; index < orderedByStart.length; index += 1) {
    const previous = orderedByStart[index - 1];
    const current = orderedByStart[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.clientCompletedAtMs <= current.clientStartedAtMs
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
    const clientStartedAtMs = readFiniteNumberField(parsed, "clientStartedAtMs");
    const clientCompletedAtMs = readFiniteNumberField(parsed, "clientCompletedAtMs");
    const server = readField(parsed, "server");
    const label = readStringField(server, "label");
    const query = readStringField(server, "query");
    const serverReceivedAtMs = readFiniteNumberField(server, "receivedAtMs");
    const serverCompletedAtMs = readFiniteNumberField(server, "completedAtMs");

    if (
      clientStartedAtMs !== undefined &&
      clientCompletedAtMs !== undefined &&
      label !== undefined &&
      query !== undefined &&
      serverReceivedAtMs !== undefined &&
      serverCompletedAtMs !== undefined
    ) {
      return [
        {
          clientCompletedAtMs,
          clientStartedAtMs,
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
      clientDurationMs: measurement.clientCompletedAtMs - measurement.clientStartedAtMs,
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
