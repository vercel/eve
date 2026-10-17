import { it, expect, vi } from "vitest";
import { z } from "zod";
const m = vi.hoisted(() => ({ execute: vi.fn((input: any) => input), definition: {} as any }));
vi.mock("#compiled/@workflow/core/index.js", async (original) => ({
  ...(await original<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ attempt: 1 }),
}));
vi.mock("#context/serialize.js", () => ({
  deserializeContext: async () => ({
    require: () => ({ graph: {}, nodeId: "a", resolvedAgent: {} }),
    get: () => undefined,
    setVirtualContext: () => {},
  }),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: () => ({ turnAgent: {} }),
}));
vi.mock("#runtime/graph.js", () => ({ getResolvedRuntimeAgentNode: () => ({}) }));
vi.mock("#execution/node-step.js", () => ({
  createNodeHarnessTools: () => new Map(),
  buildRuntimeIdentity: () => ({}),
}));
vi.mock("#execution/durable-session-store.js", () => ({ readDurableSession: () => ({}) }));
vi.mock("#execution/session.js", () => ({ hydrateDurableSession: () => ({ state: {} }) }));
vi.mock("#context/run-step.js", () => ({
  withContextScope: async (_ctx: any, session: any, f: any) => f(session),
}));
vi.mock("#execution/dynamic-connections.js", () => ({
  bindDynamicConnections: () => ({ rehydrate: async () => {} }),
}));
vi.mock("#harness/session-machine/view.js", () => ({
  storedProjection: () => ({}),
  turnPosition: () => ({ sequence: 0, turnId: "a" }),
}));
vi.mock("#harness/session-machine/commit.js", () => ({ sessionView: () => ({}) }));
vi.mock("#harness/hitl/index.js", () => ({ grantedApprovalKeys: () => [] }));
vi.mock("#execution/catalog/step-catalog.js", () => ({
  buildStepCatalog: () => ({
    get: () => m.definition,
    resolve: (call: any) => ({ definition: m.definition, call }),
  }),
}));
import { approveProgramCallStep, dispatchProgramCallStep } from "./program-step.js";
it("execution receives the validated defaulted input", async () => {
  m.definition = {
    name: "read",
    inputSchema: z.object({ value: z.number().default(7) }),
    execute: m.execute,
  };
  const call = { index: 0, tool: "read", input: {} };
  const context = { serializedContext: {}, sessionState: {} } as never;
  const approval = await approveProgramCallStep(context, call, "id", []);
  expect(approval).toMatchObject({ status: "approved", input: { value: 7 } });
  if (approval.status === "denied") throw new Error("denied");
  const outcome = await dispatchProgramCallStep(
    { abortSignal: new AbortController().signal } as never,
    context,
    { ...call, input: approval.input },
    { callId: "id", status: "started" },
    [],
  );
  expect(outcome).toMatchObject({ status: "completed", output: { value: 7 } });
  expect(m.execute.mock.calls[0]![0]).toEqual({ value: 7 });
});
