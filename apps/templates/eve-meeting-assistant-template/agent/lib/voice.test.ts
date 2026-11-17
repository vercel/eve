import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@eve/recall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@eve/recall")>()),
  callRecallApi: vi.fn(),
}));

const { callRecallApi, RecallApiError } = await import("@eve/recall");
const { voiceRoutes } = await import("./voice.js");

const KEY = "3f2b8c1e-6a4d-4e9f-8b7a-1c2d3e4f5a6b";

async function requestStream() {
  const stream = voiceRoutes().find((route) => route.path.endsWith("/voice/stream"))!;
  const resolveSession = vi.fn();
  const response = await (stream as { handler: Function }).handler(
    new Request(`https://agent.test/eve/v1/recall/voice/stream?key=${KEY}`),
    { resolveSession },
  );
  return { resolveSession, response: response as Response };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("voice stream", () => {
  it("answers a failed bot lookup with a retryable error that never logs the page key", async () => {
    vi.mocked(callRecallApi).mockRejectedValueOnce(
      new RecallApiError(`/bot/?metadata__eve_voice_key=${KEY}`, 429, `throttled ${KEY}`),
    );
    const logged: unknown[] = [];
    for (const level of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => logged.push(...args));
    }

    const { resolveSession, response } = await requestStream();

    expect(response.status).toBe(503);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(logged).toEqual(["voice: Recall bot lookup failed with HTTP 429"]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });
});
