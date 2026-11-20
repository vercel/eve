import { beforeEach, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SubscriptionBinding, SubscriptionOutcome } from "./state.js";

const { hooks, runs, started, resumed } = vi.hoisted(() => ({
  hooks: new Map<string, { runId: string; metadata: unknown }>(),
  runs: new Map<string, { published: unknown[]; outcome: Promise<unknown> }>(),
  started: vi.fn(async (_reference: unknown, _args: unknown[]) => ({ runId: "start-run" })),
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
vi.mock("#execution/workflow-references.js", () => ({
  subscriptionWorkflowReference: { workflowId: "subscription" },
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  startWorkflowOnCurrentDeployment: started,
}));

const {
  emitSubscriptionEvent,
  findSubscriptionOwner,
  retireSubscriptionOwner,
  startSubscriptionOwner,
} = await import("./owner.js");
const { subscriptionHookToken, subscriptionKeyHookToken } = await import("./state.js");

const binding: SubscriptionBinding = {
  id: "binding-1",
  source: {
    kind: "channel",
    name: "github",
    event: "checks_finished",
    key: "vercel/eve#7",
    input: {},
    ttlMs: null,
  },
  sessionId: "session-1",
  executionPrincipal: "rui",
  auth: null,
};
const token = subscriptionHookToken(binding.id);
const bundle = {
  compiledArtifactsSource: { kind: "disk", appRoot: "/virtual/subscriptions" },
} as CompiledBundle;
const opened = { key: "vercel/eve#7", expiresAt: null };

function holdRun(runId: string) {
  let publish!: (value: unknown) => void;
  const run = {
    published: [] as unknown[],
    outcome: new Promise((resolve) => (publish = resolve)),
  };
  runs.set(runId, run);
  return (value: SubscriptionOutcome) => {
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

it("starts the owner workflow and returns what the source opened once the outcome stream publishes it", async () => {
  holdRun("start-run")({ opened });

  expect(await startSubscriptionOwner(binding, bundle)).toEqual(opened);

  expect(started).toHaveBeenCalledExactlyOnceWith({ workflowId: "subscription" }, [
    { binding, serializedContext: expect.any(Object) },
  ]);
});

it("follows an ownerRunId outcome to the run that already owns the subscription", async () => {
  holdRun("start-run")({ ownerRunId: "owner-run" });
  holdRun("owner-run")({ opened });

  expect(await startSubscriptionOwner(binding, bundle)).toEqual(opened);
});

it("returns undefined when the caller stops waiting before the source answers", async () => {
  holdRun("start-run");
  const caller = new AbortController();
  const starting = startSubscriptionOwner(binding, bundle, caller.signal);
  caller.abort();
  expect(await starting).toBeUndefined();
});

it("throws the source's refusal with its status", async () => {
  holdRun("start-run")({ error: "not allowed", status: 403 });

  const refusal = await startSubscriptionOwner(binding, bundle).catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).toMatchObject({ message: "not allowed", status: 403 });
});

it("reports no owner when the subscription's hook is gone", async () => {
  expect(await findSubscriptionOwner(binding.id)).toBeUndefined();
});

it("reports a subscription still opening, then its later result", async () => {
  const publish = holdRun("owner-run");
  hooks.set(token, { runId: "owner-run", metadata: binding });

  expect(await findSubscriptionOwner(binding.id)).toEqual({ binding, opened: undefined });

  publish({ opened });
  expect(await findSubscriptionOwner(binding.id)).toEqual({ binding, opened });
});

it("hides an owner whose open was refused", async () => {
  holdRun("owner-run")({ error: "not allowed", status: 403 });
  hooks.set(token, { runId: "owner-run", metadata: binding });

  expect(await findSubscriptionOwner(binding.id)).toBeUndefined();
});

it("asks a running owner to retire, and reports one that has ended", async () => {
  expect(await retireSubscriptionOwner(binding.id)).toBe(false);
  hooks.set(token, { runId: "owner-run", metadata: binding });
  expect(await retireSubscriptionOwner(binding.id)).toBe(true);
  expect(resumed).toHaveBeenCalledExactlyOnceWith(token, { kind: "retire" });
});

it("hands an event to the run holding the key, and reports a key nobody holds", async () => {
  const source = { kind: "channel", name: "github" } as const;
  const event = { id: "e1", data: { ok: true } };
  expect(await emitSubscriptionEvent(source, "vercel/eve#7", event)).toBe(false);

  const keyToken = subscriptionKeyHookToken(source, "vercel/eve#7");
  hooks.set(keyToken, { runId: "key-run", metadata: undefined });
  expect(await emitSubscriptionEvent(source, "vercel/eve#7", event)).toBe(true);
  expect(resumed).toHaveBeenCalledExactlyOnceWith(keyToken, { kind: "emit", event });
  expect(await emitSubscriptionEvent(source, "vercel/eve#8", event)).toBe(false);
});
