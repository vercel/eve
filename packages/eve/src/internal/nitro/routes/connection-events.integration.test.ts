import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleConnectionEventRequest } from "#internal/nitro/routes/connection-events.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

const { verify, resume, load } = vi.hoisted(() => ({
  verify: vi.fn(),
  resume: vi.fn(),
  load: vi.fn(),
}));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: resume }));
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
  resume.mockResolvedValue({});
  load.mockResolvedValue({
    resolvedAgent: {
      connections: [
        {
          connectionName: "issues",
          experimental_events: { onEvent() {} },
          authorization: { vercelConnect: { experimental_events: { verify } } },
        },
      ],
    },
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("verifies the untouched request against the configured public path and acknowledges only durable inbox acceptance", async () => {
  vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/support");
  let accepted!: () => void;
  let accepting!: () => void;
  const started = new Promise<void>((resolve) => {
    accepting = resolve;
  });
  resume.mockImplementation(() => {
    accepting();
    return new Promise<void>((resolve) => {
      accepted = resolve;
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
  expect(resume).toHaveBeenCalledWith(
    { sessionId: "session-1" },
    expect.objectContaining({
      kind: "connection-event",
      bindingId: "a".repeat(64),
      connectionName: "issues",
      delivery: envelope,
    }),
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
  expect(resume).not.toHaveBeenCalled();
});

it("does not replace a retired session and leaves failed inbox writes retryable", async () => {
  resume.mockRejectedValueOnce(new HookNotFoundError("gone"));
  expect((await handleConnectionEventRequest(input, request())).status).toBe(410);
  resume.mockRejectedValueOnce(new Error("temporarily unavailable"));
  expect((await handleConnectionEventRequest(input, request())).status).toBe(503);
});

it("does not expose a receiver when the connection has not opted in", async () => {
  load.mockResolvedValue({ resolvedAgent: { connections: [] } });
  expect((await handleConnectionEventRequest(input, request())).status).toBe(404);
  expect(verify).not.toHaveBeenCalled();
});
