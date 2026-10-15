import { beforeEach, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ConnectionEventPayload } from "./delivery.js";
import type { ConnectionEventWatch, EventBinding } from "./state.js";

const { hooks, started, resumed } = vi.hoisted(() => ({
  hooks: new Map<string, { runId: string; metadata: unknown }>(),
  started: vi.fn(async (_reference: unknown, _args: unknown[]) => ({ runId: "delivery-run" })),
  resumed: vi.fn(async (_token: string, _value: unknown) => ({})),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  async getHookByToken(token: string) {
    const hook = hooks.get(token);
    if (hook === undefined) throw new HookNotFoundError(token);
    return { runId: hook.runId, metadata: Promise.resolve(hook.metadata) };
  },
  resumeHook: resumed,
  getRun: vi.fn(),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  connectionEventWorkflowReference: { workflowId: "watch" },
  connectionEventDeliveryWorkflowReference: { workflowId: "delivery" },
  startWorkflowOnCurrentDeployment: started,
}));

const { startConnectionEventDelivery, retireConnectionEventOwner } = await import("./owner.js");
const { connectionEventHookToken } = await import("./path.js");

const binding = {
  id: "binding-1",
  sessionId: "session-1",
  auth: null,
  connectionName: "issues",
} as EventBinding;
const token = connectionEventHookToken(binding.id);
const bundle = {
  compiledArtifactsSource: { kind: "disk", appRoot: "/virtual/events" },
} as CompiledBundle;
const payload = {
  kind: "connection-event",
  connectionName: "issues",
  bindingId: binding.id,
  delivery: { deliveryId: "delivery-1" },
} as ConnectionEventPayload;
const holdWatch = (ended: boolean) =>
  hooks.set(token, {
    runId: "watch-run",
    metadata: { binding, ended } satisfies ConnectionEventWatch,
  });

beforeEach(() => {
  hooks.clear();
  started.mockClear();
  resumed.mockClear();
});

it("starts each delivery in its own run, under the binding its watch's hook carries", async () => {
  holdWatch(false);
  expect(await startConnectionEventDelivery(payload, bundle)).toBe(true);
  expect(started).toHaveBeenCalledExactlyOnceWith({ workflowId: "delivery" }, [
    { binding, payload, serializedContext: expect.any(Object) },
  ]);
  // The watch's own run takes nothing per delivery.
  expect(resumed).not.toHaveBeenCalled();
});

it.each([
  ["has ended", () => holdWatch(true)],
  ["is gone", () => {}],
])("refuses a delivery when its watch %s", async (_name, arrange) => {
  arrange();
  expect(await startConnectionEventDelivery(payload, bundle)).toBe(false);
  expect(started).not.toHaveBeenCalled();
});

it("retires only a live watch", async () => {
  holdWatch(true);
  await retireConnectionEventOwner(binding.id);
  expect(resumed).not.toHaveBeenCalled();
  holdWatch(false);
  await retireConnectionEventOwner(binding.id);
  expect(resumed).toHaveBeenCalledExactlyOnceWith(token, { kind: "retire" });
});
