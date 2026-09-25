import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLegacySessionStep } from "./prepare-step.js";
const mocks = vi.hoisted(() => ({ run: vi.fn(), hydrate: vi.fn(), encryption: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: mocks.run }, getDeploymentId: async () => "new" }),
  resolveRunEncryptionKey: mocks.encryption,
}));
vi.mock("#compiled/@workflow/core/serialization.js", () => ({
  hydrateWorkflowArguments: mocks.hydrate,
}));
const session = {
  sessionId: "original",
  continuationToken: "alias",
  history: [],
  agent: { system: "old" },
};
const input = {
  completionToken: "original:turn",
  version: 2,
  stepInput: {
    input: { kind: "deliver", payloads: [] },
    parentWritable: {},
    sessionState: { sessionId: "original", snapshot: { version: 1, session } },
    serializedContext: {
      "eve.sessionCallback": { url: "https://example.com/callback" },
      "eve.channel": {
        kind: "subagent",
        state: { parentContinuationToken: "parent", callId: "call" },
      },
      "app.identity": "Alice",
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.run.mockResolvedValue({
    runId: "original",
    input: "encrypted",
    createdAt: new Date(500),
    startedAt: new Date(1000),
  });
  mocks.encryption.mockResolvedValue("key");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "new");
});
afterEach(() => vi.unstubAllEnvs());
describe("legacy session preparation", () => {
  it.each([false, 5000, undefined])(
    "retains the configured timeout duration (%s)",
    async (sessionTimeoutMs) => {
      mocks.hydrate.mockResolvedValue([{ sessionTimeoutMs, retention: 0 }]);
      const result = await prepareLegacySessionStep(input);
      expect(result.input.retention).toBe(0);
      expect(mocks.hydrate).toHaveBeenCalledWith("encrypted", "original", "key");
      expect(result.sessionTimeoutMs).toBe(sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
      expect(result.serializedContext).toMatchObject({
        "eve.sessionId": "original",
        "eve.sessionInbox": { sessionId: "original" },
        "app.identity": "Alice",
        "eve.channel": { state: { parentContinuationToken: "", callId: "call" } },
      });
      expect(result.serializedContext).not.toHaveProperty("eve.sessionCallback");
      expect(result.input.serializedContext).toEqual(input.stepInput.serializedContext);
    },
  );
});
