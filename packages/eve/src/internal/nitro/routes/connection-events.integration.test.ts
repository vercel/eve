import { eventTracing } from "#internal/testing/event-tracing.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleConnectionEventRequest } from "#internal/nitro/routes/connection-events.js";

const { verify, start, load } = vi.hoisted(() => ({
  verify: vi.fn(),
  start: vi.fn(),
  load: vi.fn(),
}));
vi.mock("#runtime/connections/events/owner.js", () => ({
  startConnectionEventDelivery: start,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: load,
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({ kind: "disk", appRoot: "/virtual/events" }),
}));
const input = {
  artifactsConfig: { kind: "production" as const, sandboxScope: "fixture" },
  connectionName: "issues",
};
const envelope = {
  context: { eve: { version: 1, sessionId: "session-1", bindingId: "a".repeat(64) } },
  subscriptionId: "sub_1",
  deliveryId: "del_1",
};
function request() {
  return new Request("https://agent.example/eve/v1/hooks/issues", {
    method: "POST",
    body: "untouched-body",
  });
}
beforeEach(() => {
  verify.mockResolvedValue(envelope);
  start.mockResolvedValue(true);
  load.mockResolvedValue({
    resolvedAgent: {
      connections: [
        {
          connectionName: "issues",
          experimental_events: { backend: { verify } },
        },
      ],
    },
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("verifies the untouched request and acknowledges only durable handler acceptance", async () => {
  vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/support");
  let accepted!: () => void;
  let accepting!: () => void;
  const started = new Promise<void>((resolve) => {
    accepting = resolve;
  });
  start.mockImplementation(() => {
    accepting();
    return new Promise<boolean>((resolve) => {
      accepted = () => resolve(true);
    });
  });
  const req = request();
  let settled = false;
  const response = handleConnectionEventRequest(input, req).then((result) => {
    settled = true;
    return result;
  });
  await started;
  expect(settled).toBe(false);
  expect(verify).toHaveBeenCalledWith(req, { path: "/eve/support/v1/hooks/issues" });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "connection-event",
      bindingId: "a".repeat(64),
      connectionName: "issues",
      delivery: envelope,
    }),
    expect.anything(),
  );
  accepted();
  expect((await response).status).toBe(202);
});

it.each([
  [{ code: "invalid_delivery" }, 401],
  [{ code: "verification_unavailable" }, 503],
  [{ code: "configuration_error" }, 503],
])("does not enqueue unverified deliveries: %j", async (error, status) => {
  verify.mockRejectedValue(error);
  expect((await handleConnectionEventRequest(input, request())).status).toBe(status);
  expect(start).not.toHaveBeenCalled();
});

it("tells Connect an ended watch is gone and leaves failed starts retryable", async () => {
  start.mockResolvedValueOnce(false);
  expect((await handleConnectionEventRequest(input, request())).status).toBe(410);
  start.mockRejectedValueOnce(new Error("temporarily unavailable"));
  expect((await handleConnectionEventRequest(input, request())).status).toBe(503);
});

it("does not expose a receiver when the connection has not opted in", async () => {
  load.mockResolvedValue({ resolvedAgent: { connections: [] } });
  expect((await handleConnectionEventRequest(input, request())).status).toBe(404);
  expect(verify).not.toHaveBeenCalled();
});

it("traces verified acceptance and propagates a serializable request parent to the durable inbox", async () => {
  const tracing = eventTracing();
  tracing.enable();
  try {
    const req = request();
    req.headers.set("traceparent", `00-${"1".repeat(32)}-${"2".repeat(16)}-01`);
    expect((await handleConnectionEventRequest(input, req)).status).toBe(202);
    const spans = tracing.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("agent.connection.event.request");
    expect(span.parentSpanContext?.spanId).toBe("2".repeat(16));
    expect(span.attributes).toMatchObject({
      "http.response.status_code": 202,
      "agent.connection.name": "issues",
      "agent.run.id": "session-1",
      "connect.delivery.id": "del_1",
    });
    expect(JSON.parse(JSON.stringify(start.mock.calls[0]![0])).requestTraceContext).toEqual({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      traceFlags: 1,
    });
    expect(JSON.stringify(span.attributes)).not.toContain("untouched-body");
  } finally {
    await tracing.close();
  }
});

it("keeps unverified identifiers and error content out of request spans while preserving retry responses", async () => {
  const tracing = eventTracing();
  tracing.enable();
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  verify.mockRejectedValue(
    Object.assign(new Error("secret-provider-response"), { code: "ETIMEDOUT" }),
  );
  try {
    const response = await handleConnectionEventRequest(input, request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.text()).toBe("");
    const span = tracing.exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2);
    expect(JSON.stringify(logging.mock.calls)).toContain("ETIMEDOUT");
    expect(JSON.stringify(logging.mock.calls)).toContain("verify");
    expect(span.attributes["agent.connection.name"]).toBeUndefined();
    expect(span.attributes["agent.run.id"]).toBeUndefined();
    expect(
      JSON.stringify([span.attributes, span.events, span.status, logging.mock.calls]),
    ).not.toContain("secret-provider-response");
  } finally {
    logging.mockRestore();
    await tracing.close();
  }
});
