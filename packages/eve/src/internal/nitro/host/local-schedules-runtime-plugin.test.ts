import { afterEach, expect, it, onTestFinished, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pointer: vi.fn<() => string | undefined>(),
  manifest: vi.fn(async (_input: { compiledArtifactsSource: unknown }) => ({
    config: { name: "fixture" },
    scheduleCollections: [{ providerKind: "vercel" }],
  })),
  receive: vi.fn(async () => ({ ok: false, reason: "empty" })),
}));

vi.mock("#compiled/@vercel/queue/index.js", () => ({
  PollingQueueClient: class {
    receive = mocks.receive;
  },
}));
vi.mock("#internal/nitro/dev-runtime-artifacts.js", () => ({
  resolveDevelopmentRuntimeArtifactsPointerPath: () => "pointer.json",
  readDevelopmentRuntimeArtifactsSnapshotRoot: mocks.pointer,
}));
vi.mock("#runtime/loaders/manifest.js", () => ({ loadCompiledManifest: mocks.manifest }));
vi.mock("#internal/nitro/routes/schedule-collection-consumer.js", () => ({
  createScheduleCollectionConsumer: () => ({ handler: async () => {}, retry: () => undefined }),
}));

import installLocalSchedulesRuntimePlugin from "./local-schedules-runtime-plugin.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("waits for a snapshot, refreshes only on generation changes, and bounds failed polling", async () => {
  vi.useFakeTimers();
  vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", "/fixture");
  vi.stubEnv("VERCEL_QUEUE_BASE_URL", "http://127.0.0.1:4782");
  vi.stubEnv("VERCEL_QUEUE_TOKEN", "queue-secret");
  vi.stubEnv("VERCEL_SCHEDULE_TOKEN", "schedule-secret");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let close: (() => void) | undefined;
  onTestFinished(() => close?.());
  installLocalSchedulesRuntimePlugin({
    hooks: {
      hook: (_name, handler) => {
        close = handler;
      },
    },
  });

  expect(mocks.manifest).not.toHaveBeenCalled();
  expect(mocks.receive).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();

  mocks.pointer.mockReturnValue("/generation-one");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(mocks.manifest).toHaveBeenCalledTimes(1);
  expect(mocks.manifest.mock.calls[0]?.[0]).toMatchObject({
    compiledArtifactsSource: { appRoot: "/generation-one" },
  });
  expect(mocks.receive).toHaveBeenCalledTimes(3);

  mocks.pointer.mockReturnValue("/generation-two");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.manifest).toHaveBeenCalledTimes(2);
  expect(mocks.manifest.mock.calls[1]?.[0]).toMatchObject({
    compiledArtifactsSource: { appRoot: "/generation-two" },
  });

  mocks.receive.mockRejectedValue(new Error("Authentication failed: queue-secret schedule-secret"));
  const attempts = mocks.receive.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("Authentication failed: [redacted] [redacted]");
  expect(warn.mock.calls[0]?.[0]).not.toContain("queue-secret");
  expect(warn.mock.calls[0]?.[0]).not.toContain("schedule-secret");
  expect(mocks.receive.mock.calls.length - attempts).toBeLessThan(10);

  close!();
  const stopped = mocks.receive.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.receive).toHaveBeenCalledTimes(stopped);
});
