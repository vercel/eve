import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";

import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  type AuthorizationChallenge,
  type AuthorizationResult,
  SignInCompletedKey,
} from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { applyHumanDecisions } from "#harness/hitl/intake.js";
import { eventsOf } from "#harness/publication.js";
import type { ApprovedCall, SuspendedStep } from "#harness/session-machine/state.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessSession, KernelConfig } from "#harness/types.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import type { SessionEvent } from "#protocol/session-event.js";

// The parked calls run with the catalog the step builds; here, the tools each test names.
const catalog = vi.hoisted(() => ({ tools: new Map<string, HarnessToolDefinition>() }));
vi.mock("#definitions/step.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#definitions/step.js")>()),
  stepCatalog: async () => catalog.tools,
}));

function tool(name: string, execute: () => Promise<unknown>): HarnessToolDefinition {
  return {
    description: name,
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  } as HarnessToolDefinition;
}

function challenge(attemptId: string): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { kind: "redirect", url: `https://example.test/${attemptId}` },
    hookUrl: `https://example.test/hook/${attemptId}`,
    name: "github",
  } as AuthorizationChallenge;
}

function completion(attemptId: string): AuthorizationResult {
  return {
    attemptId,
    callback: { params: {} },
    hookUrl: `https://example.test/hook/${attemptId}`,
  } as AuthorizationResult;
}

function signInRow(interactionId: string): InteractionRow {
  return {
    interactionId,
    introducedAt: 0,
    startedAt: "1970-01-01T00:00:00.000Z",
    request: { kind: "sign-in", prompt: "Sign in to GitHub", signIn: { name: "github" } },
    status: "open",
    subject: { callId: `call-${interactionId}` },
  };
}

function call(callId: string, attemptId?: string): ApprovedCall {
  return {
    call: { callId, input: {}, toolName: callId },
    interactionId: `approval-${callId}`,
    ...(attemptId !== undefined && { signIns: [challenge(attemptId)] }),
  };
}

/** A model step parked on its calls: the intake runs each such step's calls as one group. */
function parked(stepIndex: number): SuspendedStep {
  return {
    event: { sequence: 1, stepIndex, turnId: "turn-1" },
    messages: [],
    requests: [],
    tasks: [],
  };
}

/** The context of a step whose agent sets nothing, which the calls' settings read. */
function agentContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, { resolvedAgent: { config: {} }, turnAgent: {} } as never);
  return ctx;
}

/**
 * A step whose sign-ins stay open as far as its view says, so only the batch's reporter settles
 * each once. `publish` fails for what `fails` names.
 */
function intakeStep(attemptIds: readonly string[], fails?: (event: SessionEvent) => boolean) {
  const published: SessionEvent[] = [];
  const projection = {
    ...initialSessionProjection(),
    view: {
      ...emptySessionView(),
      interactions: Object.fromEntries(attemptIds.map((id) => [id, signInRow(id)])),
    },
  };
  const view = (): SessionView => ({
    projection,
    relayedRequestIds: new Set(),
    responders: {},
    signIns: [],
    turn: { remembered: {}, suspended: [] },
  });
  const publish: Step["publish"] = async (publication) => {
    const events = eventsOf(publication);
    if (fails !== undefined && events.some(fails)) throw new Error("publish failed");
    published.push(...events);
  };
  const step = {
    apply: async () => {},
    config: { abortSignal: undefined } as KernelConfig,
    ctx: agentContext(),
    frameworkToolNames: new Set<string>(),
    instrumentation: undefined,
    publish,
    session: { history: [] } as Partial<HarnessSession> as HarnessSession,
    view,
  } as Partial<Step> as Step;
  const settled = (attemptId: string) =>
    published.filter(
      (event) => event.type === "interaction.settled" && event.data.interactionId === attemptId,
    ).length;
  return { settled, step };
}

/** Completes a sign-in the way a connection does: through the reporter the step's context holds. */
async function completeSignIn(attemptId: string): Promise<void> {
  await loadContext().get(SignInCompletedKey)?.(completion(attemptId));
}

it("settles each asking step's sign-in while its call still holds", async () => {
  const { settled, step } = intakeStep(["attempt-a", "attempt-b"]);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seenWhileHeld: Record<string, number> = {};
  const holding = (attemptId: string) => async () => {
    await completeSignIn(attemptId);
    seenWhileHeld[attemptId] = settled(attemptId);
    await held;
    return "done";
  };
  catalog.tools = new Map([
    ["call-a", tool("call-a", holding("attempt-a"))],
    ["call-b", tool("call-b", holding("attempt-b"))],
  ]);

  const applied = contextStorage.run(step.ctx, () =>
    applyHumanDecisions(step, {
      approved: [
        { approval: call("call-a", "attempt-a"), step: parked(0) },
        { approval: call("call-b", "attempt-b"), step: parked(1) },
      ],
      settledApprovals: false,
    }),
  );
  await vi.waitFor(() => expect(Object.keys(seenWhileHeld)).toHaveLength(2));
  release();
  await applied;

  expect(seenWhileHeld).toEqual({ "attempt-a": 1, "attempt-b": 1 });
  expect(settled("attempt-a")).toBe(1);
  expect(settled("attempt-b")).toBe(1);
  expect(step.ctx.get(SignInCompletedKey)).toBeUndefined();
});

it("keeps the reporter for a step still running after another step's calls fail", async () => {
  const failsA = (event: SessionEvent) =>
    "callId" in event.data && event.data.callId === "call-a" && event.type === "call.settled";
  let failedA = () => {};
  const aFailed = new Promise<void>((resolve) => {
    failedA = resolve;
  });
  const { settled, step } = intakeStep(["attempt-b"], (event) => {
    const failing = failsA(event);
    if (failing) failedA();
    return failing;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seenWhileHeld: number | undefined;
  catalog.tools = new Map([
    ["call-a", tool("call-a", async () => "done")],
    [
      "call-b",
      tool("call-b", async () => {
        // The sign-in completes only after the other step's calls have failed and their group
        // has rejected.
        await aFailed;
        await new Promise((resolve) => setImmediate(resolve));
        await completeSignIn("attempt-b");
        seenWhileHeld = settled("attempt-b");
        await held;
        return "done";
      }),
    ],
  ]);

  const applied = contextStorage.run(step.ctx, () =>
    applyHumanDecisions(step, {
      approved: [
        { approval: call("call-a"), step: parked(0) },
        { approval: call("call-b", "attempt-b"), step: parked(1) },
      ],
      settledApprovals: false,
    }),
  );
  const outcome = applied.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(seenWhileHeld).toBeDefined());
  release();

  expect(await outcome).toEqual(new Error("publish failed"));
  expect(seenWhileHeld).toBe(1);
  expect(settled("attempt-b")).toBe(1);
  expect(step.ctx.get(SignInCompletedKey)).toBeUndefined();
});
