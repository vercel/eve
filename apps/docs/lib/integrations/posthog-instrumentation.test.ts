import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  runtimeContext: undefined as RuntimeContextResolver | undefined,
}));

vi.mock("eve/instrumentation/otel", () => ({
  otelIntegration: (options: { runtimeContext: RuntimeContextResolver }) => {
    captured.runtimeContext = options.runtimeContext;
    return options;
  },
}));
vi.mock("@posthog/ai/otel", () => ({ PostHogTraceExporter: class {} }));

// PostHog resolves each span's distinct id from these span attributes, in order:
// https://github.com/PostHog/posthog/blob/master/rust/capture/src/otel/identity.rs
const POSTHOG_SPAN_DISTINCT_ID_KEYS = [
  "ai.telemetry.metadata.posthog_distinct_id",
  "ai.settings.context.posthog_distinct_id",
  "posthog.distinct_id",
  "user.id",
] as const;

type RuntimeContextResolver = (input: unknown) => Record<string, unknown> | undefined;

function posthogDistinctId(attributes: Record<string, unknown>): unknown {
  const key = POSTHOG_SPAN_DISTINCT_ID_KEYS.find((candidate) => attributes[candidate]);
  return key === undefined ? undefined : attributes[key];
}

describe("PostHog instrumentation template", () => {
  it("records the session initiator under a span attribute PostHog reads as the distinct id", async () => {
    await import("../../registry/instrumentation/posthog");
    const { runtimeContext } = captured;
    if (runtimeContext === undefined) throw new Error("template did not register runtimeContext");

    const context = runtimeContext({
      session: { auth: { current: null, initiator: { principalId: "user-1" } } },
    });
    // eve records each runtime-context key on model spans as `ai.settings.context.<key>`.
    const spanAttributes = Object.fromEntries(
      Object.entries(context ?? {}).map(([key, value]) => [`ai.settings.context.${key}`, value]),
    );

    expect(posthogDistinctId(spanAttributes), JSON.stringify(spanAttributes)).toBe("user-1");
  });
});
