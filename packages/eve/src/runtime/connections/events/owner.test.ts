import { beforeEach, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ConnectionEventPayload } from "./delivery.js";
import type { ConnectionEventSubscribeOutcome, EventBinding } from "./state.js";

const { hooks, runs, started, resumed } = vi.hoisted(() => ({
  hooks: new Map<string, { runId: string; metadata: unknown }>(),
  runs: new Map<string, { published: unknown[]; outcome: Promise<unknown> }>(),
  started: vi.fn(async (_reference: unknown, _args: unknown[]) => ({ runId: "watch-run" })),
  resumed: vi.fn(async (_token: string, _value: unknown) => ({})),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  async getHookByToken(token: string) {
    const hook = hooks.get(token);
    if (hook === undefined) throw new HookNotFoundError(token);
    return { runId: hook.runId, metadata: Promise.resolve(hook.metadata) };
  },
  async resumeHook(token: string, value: unknown) {
    if (!hooks.has(token)) throw new HookNotFoundError(token);
    return resumed(token, value);
  },
  getRun(runId: string) {
    const run = runs.get(runId)!;
    // The run's published subscribe outcome, as its stream delivers it.
    return {
      getReadable: () =>
        Object.assign(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(await run.outcome);
              controller.close();
            },
          }),
          { getTailIndex: async () => run.published.length - 1 },
        ),
    };
  },
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  connectionEventWorkflowReference: { workflowId: "watch" },
  connectionEventDeliveryWorkflowReference: { workflowId: "delivery" },
  startWorkflowOnCurrentDeployment: started,
}));

const {
  findConnectionEventOwner,
  retireConnectionEventOwner,
  startConnectionEventDelivery,
  startConnectionEventOwner,
} = await import("./owner.js");
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
  delivery: { deliveryId: "delivery-1", subscriptionId: "sub_1" },
} as ConnectionEventPayload;
const subscription = {
  id: "sub_1",
  name: "issue.created",
  arguments: {},
  status: "active" as const,
  expiresAt: null,
};
/** A running watch holding its hook; call the result to publish its subscribe outcome. */
function holdWatch() {
  let publish!: (value: unknown) => void;
  const run = {
    published: [] as unknown[],
    outcome: new Promise((resolve) => (publish = resolve)),
  };
  runs.set("watch-run", run);
  hooks.set(token, { runId: "watch-run", metadata: binding });
  return (value: ConnectionEventSubscribeOutcome) => {
    run.published.push(value);
    publish(value);
  };
}

beforeEach(() => {
  hooks.clear();
  runs.clear();
  started.mockClear();
  resumed.mockClear();
});

it("starts each delivery in its own run, under the binding its watch's hook carries", async () => {
  holdWatch()({ subscription });
  expect(await startConnectionEventDelivery(payload, bundle)).toBe(true);
  expect(started).toHaveBeenCalledExactlyOnceWith({ workflowId: "delivery" }, [
    { binding, payload, serializedContext: expect.any(Object) },
  ]);
  // The watch's own run takes nothing per delivery.
  expect(resumed).not.toHaveBeenCalled();
});

it("refuses a delivery for a subscription its watch did not create", async () => {
  holdWatch()({ subscription });
  const other = { ...payload, delivery: { ...payload.delivery, subscriptionId: "sub_other" } };
  expect(await startConnectionEventDelivery(other, bundle)).toBe(false);
  expect(started).not.toHaveBeenCalled();
});

it("refuses a delivery when its watch has ended", async () => {
  expect(await startConnectionEventDelivery(payload, bundle)).toBe(false);
  expect(started).not.toHaveBeenCalled();
});

it("hands a delivery that beats the subscribe response to the watch's own run", async () => {
  holdWatch();
  expect(await startConnectionEventDelivery(payload, bundle)).toBe(true);
  expect(resumed).toHaveBeenCalledExactlyOnceWith(token, { kind: "delivery", payload });
  expect(started).not.toHaveBeenCalled();
});

it("asks a running watch to retire, and reports one that has ended", async () => {
  expect(await retireConnectionEventOwner(binding.id)).toBe(false);
  holdWatch();
  expect(await retireConnectionEventOwner(binding.id)).toBe(true);
  expect(resumed).toHaveBeenCalledExactlyOnceWith(token, { kind: "retire" });
});

it("reports a subscribe still in flight when the caller stops waiting, then its later result", async () => {
  const publish = holdWatch();
  const caller = new AbortController();
  const subscribing = startConnectionEventOwner(binding, bundle, caller.signal);
  caller.abort();
  expect(await subscribing).toBeUndefined();
  expect(await findConnectionEventOwner(binding.id)).toEqual({
    owner: binding,
    subscription: undefined,
  });
  publish({ subscription });
  expect(await findConnectionEventOwner(binding.id)).toEqual({ owner: binding, subscription });
});
