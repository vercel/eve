import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineTool } from "#tools/definition.js";
import { always } from "#tools/approval/policies.js";
import { z } from "zod";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import type { HarnessSession } from "#harness/types.js";
import { applyValueDelta } from "#shared/value-delta.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { sandboxPrepareWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import {
  startTestSession,
  type TestSessionHostKind,
} from "#internal/testing/test-session-hosts.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";

const stopStep = vi.hoisted(() => ({ calls: 0, rejects: false }));

vi.mock("#execution/session/idle-sandbox-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/session/idle-sandbox-step.js")>();
  return {
    ...actual,
    stopIdleSessionSandboxStep: async (
      input: Parameters<typeof actual.stopIdleSessionSandboxStep>[0],
    ) => {
      stopStep.calls += 1;
      if (stopStep.rejects) throw new Error("The idle stop step failed.");
      return await actual.stopIdleSessionSandboxStep(input);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.useRealTimers();
  stopStep.rejects = false;
});

type TestAppDescriptor = NonNullable<Parameters<typeof createTestRuntime>[0]>;

const SETTLE_MS = 500;

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function scriptedAgent(script: (prompt: string, firstUser: string) => StreamResult) {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) =>
        script(
          JSON.stringify(prompt),
          JSON.stringify(prompt.find((message) => message.role === "user")?.content ?? ""),
        ),
      modelId: "scripted",
      provider: "eve-test",
    }),
  );
  return {
    definition: defineAgent({
      model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
    }),
  };
}

function hookModule(slug: string, hook: HookDefinition) {
  return { logicalPath: `hooks/${slug}.ts`, loadNamespace: async () => ({ default: hook }) };
}

function sandboxOnTurns(opens: (turn: number) => boolean = () => true) {
  let turn = 0;
  return hookModule(
    "sandbox",
    defineHook({
      events: {
        async "turn.started"(_event, ctx) {
          turn += 1;
          if (opens(turn)) await ctx.getSandbox();
        },
      },
    }),
  );
}

async function stopStepCount(
  host: TestSessionHostKind,
  runId: string,
): Promise<number | undefined> {
  if (host !== "workflow") return undefined;
  const steps = await (await getWorld()).steps.list({ runId });
  return steps.data.filter((step) => step.stepName.endsWith("//stopIdleSessionSandboxStep")).length;
}

async function withSession(
  host: TestSessionHostKind,
  options: {
    readonly agent?: TestAppDescriptor["agent"];
    readonly beforeSandboxStart?: TestAppDescriptor["beforeSandboxStart"];
    readonly name: string;
    readonly input: { readonly message?: string };
    readonly modules: TestAppDescriptor["modules"];
    readonly sandboxIdle: TestAppDescriptor["sandboxIdle"];
    readonly stepFaults?: StepFaults;
  },
  body: (session: {
    readonly id: string;
    events(): string[];
    nextTurn(): Promise<SessionStreamEvent[]>;
    nextUntil(matches: (event: SessionStreamEvent) => boolean): Promise<SessionStreamEvent[]>;
    send(message: string): Promise<void>;
    answer(interactionId: string): Promise<void>;
    cancel(): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const runtime = await createTestRuntime({
    agent: { ...options.agent, name: options.name },
    beforeSandboxStart: options.beforeSandboxStart,
    modules: options.modules,
    sandboxIdle: options.sandboxIdle,
  });
  await runtime.run(async () => {
    const run = await startTestSession(
      host,
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        sessionTimeoutMs: false,
        input: options.input,
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http" }),
          "eve.capabilities": { requestInput: true },
        },
      },
      options.stepFaults === undefined ? {} : { stepFaults: options.stepFaults },
    );
    const inbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    const id = run.runId;
    try {
      await body({
        cancel: () => resumeRoutedHook(inbox, { deliveryId: "cancel-turn", kind: "cancel" }),
        id,
        events: () =>
          runtime.sandboxEvents
            .filter((event) => event.endsWith(`:${id}`))
            .map((event) => event.replace(`:${id}`, "")),
        nextTurn: () => stream.nextTurn(),
        nextUntil: (matches) => stream.nextUntil(matches),
        send: async (message) => {
          const delivery = createChannelDeliveryMetadata({
            channelKind: "http",
            channelName: "test",
          });
          await vi.waitFor(() =>
            resumeRoutedHook(inbox, { auth: ALICE, delivery, kind: "send", payload: { message } }),
          );
        },
        answer: async (interactionId) => {
          await resumeRoutedHook(inbox, {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { answers: [{ interactionId, optionId: "approve" }] },
          });
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => undefined);
    }
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe.each(["in-process", "workflow"] as const)("idle sandbox stop on the %s host", (host) => {
  it("stops the sandbox once the session goes idle, and resumes it only when a later turn uses it", async () => {
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns()],
        name: `idle-stop-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));

        await session.send("Alice asks for a summary of the notes.");
        await session.nextTurn();
        await vi.waitFor(() =>
          expect(session.events()).toEqual(["definition", "start", "idle", "resume", "idle"]),
        );
      },
    );
  });

  it("adds no stop when nothing opened the sandbox, and prewarming with 0 does not start it", async () => {
    await withSession(
      host,
      {
        input: {},
        modules: [],
        name: `idle-untouched-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await settle();

        expect(session.events()).toEqual([]);
        expect(await stopStepCount(host, session.id)).toBe(host === "workflow" ? 0 : undefined);
      },
    );
  });

  it("keeps the sandbox running into a turn that a hook starts with ctx.continue()", async () => {
    let settled = 0;
    await withSession(
      host,
      {
        input: { message: "Alice starts the weekly report." },
        modules: [
          sandboxOnTurns(),
          hookModule(
            "continue",
            defineHook({
              events: {
                "turn.settled"(_event, ctx) {
                  settled += 1;
                  if (settled === 1) ctx.continue("Keep going with the report.");
                },
              },
            }),
          ),
        ],
        name: `idle-continue-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await session.nextTurn();
        await vi.waitFor(() =>
          expect(session.events()).toEqual(["definition", "start", "resume", "idle"]),
        );
      },
    );
  });

  it("clears the marker when the stop fails, without retrying it", async () => {
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: `idle-failed-stop-${host}`,
        sandboxIdle: {
          idleTimeoutMs: 0,
          onSessionIdle: async () => {
            throw new Error("The sandbox service is unavailable.");
          },
        },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));

        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await settle();

        expect(session.events()).toEqual(["definition", "start", "idle"]);
        expect(await stopStepCount(host, session.id)).toBe(host === "workflow" ? 1 : undefined);
      },
    );
  });

  it("stops a sandbox that a cancelled turn opened", async () => {
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withSession(
      host,
      {
        input: { message: "Alice starts a long data export." },
        modules: [
          hookModule(
            "sandbox",
            defineHook({
              events: {
                async "model.started"(_event, ctx) {
                  await ctx.getSandbox();
                  opened.resolve();
                  await release.promise;
                },
              },
            }),
          ),
        ],
        name: `idle-cancelled-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await opened.promise;
        await session.cancel();
        await settle();
        release.resolve();
        const turn = await session.nextTurn();

        expect(turn).toContainEqual(
          expect.objectContaining({
            type: "turn.settled",
            data: expect.objectContaining({ outcome: "cancelled" }),
          }),
        );
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
      },
    );
  });

  it.runIf(host === "in-process")(
    "stops a sandbox that a turn step opened before its completion was lost",
    async () => {
      let lost = false;
      await withSession(
        host,
        {
          input: { message: "Alice opens the project notes." },
          modules: [sandboxOnTurns((turn) => turn === 1)],
          name: `idle-recovered-${host}`,
          sandboxIdle: { idleTimeoutMs: 0 },
          stepFaults: {
            loseCompletion: (step) => {
              if (lost || step.name !== "turnStep") return false;
              lost = true;
              return true;
            },
          },
        },
        async (session) => {
          await session.nextTurn();

          await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
        },
      );
    },
  );

  it("stops a prewarmed sandbox when no message arrives within the window", async () => {
    await withSession(
      host,
      {
        input: {},
        modules: [],
        name: `idle-prewarmed-${host}`,
        sandboxIdle: { idleTimeoutMs: 200 },
      },
      async (session) => {
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it("stops a prewarmed sandbox after a first message that arrived while it was starting", async () => {
    const started = Promise.withResolvers<void>();
    await withSession(
      host,
      {
        beforeSandboxStart: () => started.promise,
        input: {},
        modules: [],
        name: `idle-prewarm-race-${host}`,
        sandboxIdle: { idleTimeoutMs: 200 },
      },
      async (session) => {
        await vi.waitFor(() => expect(session.events()).toEqual(["definition"]), {
          timeout: 10_000,
        });
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        started.resolve();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it.runIf(host === "workflow")(
    "stops a sandbox that only a workflow tool run opened",
    async () => {
      await withSession(
        host,
        {
          agent: scriptedAgent((prompt) =>
            prompt.includes('"role":"tool"')
              ? textStreamResult("The service is prepared.")
              : toolCallsStreamResult([
                  {
                    input: JSON.stringify({ service: "api" }),
                    toolCallId: "call_prepare",
                    toolName: "prepare",
                  },
                ]),
          ),
          input: { message: "Alice asks to prepare the api service." },
          modules: [
            {
              logicalPath: "tools/prepare.ts",
              loadNamespace: async () => ({
                default: defineWorkflowTool({
                  description: "Prepare a service in the sandbox.",
                  execute: sandboxPrepareWorkflow,
                  inputSchema: {},
                }),
              }),
            },
          ],
          name: `idle-workflow-tool-${host}`,
          sandboxIdle: { idleTimeoutMs: 0 },
        },
        async (session) => {
          await session.nextTurn();

          await vi.waitFor(
            () => expect(session.events()).toEqual(["definition", "start", "idle"]),
            {
              timeout: 10_000,
            },
          );
        },
      );
    },
  );

  it("stops a sandbox that only a child sharing it opened, once the parent goes idle", async () => {
    await withSession(
      host,
      {
        agent: scriptedAgent((prompt, firstUser) => {
          if (firstUser.includes("CHILD:")) return textStreamResult("The report is exported.");
          if (!prompt.includes('"toolName":"agent"'))
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ message: "CHILD: export the report" }),
                toolCallId: "call_agent",
                toolName: "agent",
              },
            ]);
          return textStreamResult("The report is ready.");
        }),
        input: { message: "Alice asks for the report export." },
        modules: [
          hookModule(
            "child-sandbox",
            defineHook({
              events: {
                async "turn.started"(_event, ctx) {
                  if (ctx.session.parent !== undefined) await ctx.getSandbox();
                },
              },
            }),
          ),
        ],
        name: `idle-shared-child-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          timeout: 10_000,
        });
      },
    );
  });

  it("starts the idle window again after a turn that arrives inside it", async () => {
    const windowMs = 2_000;
    await withSession(
      host,
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: `idle-window-reset-${host}`,
        sandboxIdle: { idleTimeoutMs: windowMs },
      },
      async (session) => {
        await session.nextTurn();
        await new Promise((resolve) => setTimeout(resolve, windowMs / 3));
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        const secondTurnEndedAt = Date.now();

        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]), {
          interval: 20,
          timeout: 10_000,
        });
        expect(Date.now() - secondTurnEndedAt).toBeGreaterThanOrEqual(windowMs - 150);
      },
    );
  });

  it("keeps the sandbox running while a turn waits for an approval", async () => {
    await withSession(
      host,
      {
        agent: scriptedAgent((prompt) =>
          prompt.includes('"toolName":"deploy"')
            ? textStreamResult("Deployed.")
            : toolCallsStreamResult([
                { input: "{}", toolCallId: "call_deploy", toolName: "deploy" },
              ]),
        ),
        input: { message: "Alice asks to deploy the api service." },
        modules: [
          sandboxOnTurns(),
          {
            logicalPath: "tools/deploy.ts",
            loadNamespace: async () => ({
              default: defineTool({
                approval: { request: always() },
                description: "Deploy the service.",
                execute: async () => ({ deployed: true }),
                inputSchema: z.object({}).passthrough(),
              }),
            }),
          },
        ],
        name: `idle-approval-${host}`,
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        const asked = await session.nextUntil((event) => event.type === "interaction.opened");
        const opened = asked.at(-1);
        if (opened?.type !== "interaction.opened") throw new Error("No approval was requested.");
        await settle();
        expect(session.events()).toEqual(["definition", "start"]);

        await session.answer(opened.data.interactionId);
        await session.nextUntil((event) => event.type === "turn.settled");
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
      },
    );
  });
});

describe("idle sandbox stop step", () => {
  it("aborts the provider call, returns, and clears the marker when the provider never finishes stopping", async () => {
    const called = Promise.withResolvers<AbortSignal | undefined>();
    const runtime = await createTestRuntime({
      sandboxIdle: {
        idleTimeoutMs: 0,
        onSessionIdle: async (_sessionId, signal) => {
          called.resolve(signal);
          await new Promise<never>(() => {});
        },
      },
    });
    await runtime.run(async () => {
      const serializedContext = {
        ...buildSerializedContext({ channelKind: "http" }),
        "eve.sessionId": "idle-stop-hung-provider",
      };
      const checkpoint: HarnessSession = {
        compaction: {},
        continuationToken: "idle-stop-hung-provider",
        history: [],
        sandboxState: { running: { idleTimeoutMs: 0 }, session: null },
        sessionId: serializedContext["eve.sessionId"],
      };
      const sessionState = createDurableSessionState({ session: checkpoint });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const step = stopIdleSessionSandboxStep({ serializedContext, sessionState });
      const signal = await called.promise;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      const { stateDelta } = await step;

      expect(signal?.aborted).toBe(true);
      const next = applyValueDelta(sessionState, stateDelta.sessionState);
      expect(readDurableSession(next).sandboxState).not.toHaveProperty("running");
      expect(runtime.sandboxEvents).toEqual([`idle:${checkpoint.sessionId}`]);
    });
  });

  it("keeps the session running when the step rejects, and tries again only after the next turn", async () => {
    stopStep.calls = 0;
    stopStep.rejects = true;
    await withSession(
      "in-process",
      {
        input: { message: "Alice opens the project notes." },
        modules: [sandboxOnTurns((turn) => turn === 1)],
        name: "idle-stop-rejected",
        sandboxIdle: { idleTimeoutMs: 0 },
      },
      async (session) => {
        await session.nextTurn();
        await vi.waitFor(() => expect(stopStep.calls).toBe(1));

        await session.cancel();
        await settle();
        expect(stopStep.calls).toBe(1);

        stopStep.rejects = false;
        await session.send("Alice asks for a short greeting.");
        await session.nextTurn();
        await vi.waitFor(() => expect(session.events()).toEqual(["definition", "start", "idle"]));
        expect(stopStep.calls).toBe(2);
      },
    );
  });
});
