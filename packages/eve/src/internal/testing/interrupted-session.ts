import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { expect } from "vitest";
import { z } from "zod";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { defineDynamic } from "#dynamic/definition.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import type { StepAttempt, StepFaults } from "#execution/in-process/step-attempts.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import {
  deployServiceBody,
  deployServiceWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

// A session whose turn steps lose their completion after they ran, as a process that exits
// before its checkpoint saves does, or fail their session writes, so the step runs again. The
// in-process host's step faults inject them; the host battery (`session-host/`) checks that
// Workflow retries the same way.

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

export interface InterruptedSession {
  readonly next: (label: string) => Promise<SessionStreamEvent[]>;
  readonly answer: (interactionId: string, optionId: string) => Promise<void>;
  readonly send: (message: string) => Promise<void>;
  /** Alice stops the turn that is running. */
  readonly cancel: () => Promise<void>;
  readonly events: () => readonly SessionStreamEvent[];
  readonly interrupted: () => number;
  /** How many session writes the faults failed so far. */
  readonly failedWrites: () => number;
}

export interface InterruptedSessionOptions {
  readonly tools: readonly {
    readonly name: string;
    readonly approval?: boolean;
    /** Runs as a workflow, whose result the turn waits on. */
    readonly workflow?: true;
  }[];
  /** What the model answers each call, from the prompt it reads. */
  readonly respond: (prompt: string, call: number) => StreamResult;
  /** The turn step that publishes the `nth` of these facts loses its completion once. */
  readonly interruptAfter?: { readonly type: string; readonly nth?: number };
  /** Which turn-step completions, counted from 1, are lost. */
  readonly loseTurnStep?: (completion: number) => boolean;
  /** How many turn-step attempts, from the first, fail their first session write. */
  readonly failTurnStepWrites?: number;
  /** The first session write containing this fails, and so does every later write of its attempt. */
  readonly failWriteOf?: string;
  /**
   * A turn step that threw runs again only once its turn is stopped, as a cancel during
   * Workflow's retry delay finds it.
   */
  readonly holdRetryUntilStopped?: true;
}

/**
 * Runs `body` against a session of an agent with `options.tools`, losing the turn-step
 * completions `options` names. Once `body` returns, checks the session's stream: every line
 * follows the one before it, and no fact is written twice.
 */
export async function withInterruptedSession(
  name: string,
  options: InterruptedSessionOptions,
  body: (session: InterruptedSession) => Promise<void>,
): Promise<{ prompts: string[]; ran: string[]; observed: number }> {
  const prompts: string[] = [];
  const ran: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (call: LanguageModelV4CallOptions) => {
        const prompt = JSON.stringify(call.prompt);
        prompts.push(prompt);
        return options.respond(prompt, prompts.length);
      },
      modelId: name,
      provider: "eve-test",
    }),
  );
  let seen = 0;
  let armed = false;
  let interrupted = 0;
  let turnSteps = 0;
  const failed = { writes: 0 };
  /** Whether the turn step completing now loses its completion. */
  const loses = (): boolean => {
    const lost = options.loseTurnStep?.(++turnSteps) === true || armed;
    if (lost) {
      armed = false;
      interrupted += 1;
    }
    return lost;
  };
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              [options.interruptAfter?.type ?? "session.started"]() {
                seen += 1;
                if (
                  options.interruptAfter !== undefined &&
                  seen === (options.interruptAfter.nth ?? 1)
                )
                  armed = true;
              },
            },
          }),
        }),
        logicalPath: "hooks/interrupt.ts",
      },
      ...options.tools.map((tool) => ({
        loadNamespace: async () => ({
          default: tool.workflow
            ? defineWorkflowTool({
                description: `Run ${tool.name} for Alice.`,
                execute: deployServiceWorkflow,
                inputSchema: { properties: { service: { type: "string" } }, type: "object" },
              })
            : defineTool({
                approval: tool.approval === true ? { request: always() } : undefined,
                description: `Run ${tool.name} for Alice.`,
                execute: () => {
                  ran.push(tool.name);
                  return { done: tool.name };
                },
                inputSchema: z.object({}).passthrough(),
              }),
        }),
        logicalPath: `tools/${tool.name}.ts`,
      })),
    ],
  });
  const continuationToken = `http:${name}`;
  const events: SessionStreamEvent[] = [];
  await runtime.run(async () => {
    const run = await startTestSession(
      "in-process",
      {
        input: { message: "Help Alice with her account." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
      { stepFaults: inProcessFaults(options, loses, failed), workflows: [deployServiceBody()] },
    );
    const commandInbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    try {
      await body({
        async answer(interactionId, optionId) {
          await resumeRoutedHook(commandInbox, {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { answers: [{ interactionId, optionId }] },
          });
        },
        async cancel() {
          await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
            auth: ALICE,
            deliveryId: "alice-stop",
            kind: "cancel",
          });
        },
        events: () => events,
        failedWrites: () => failed.writes,
        interrupted: () => interrupted,
        async next(label) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const read = await Promise.race([
            stream.nextTurn(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Timed out waiting for ${label} after: ${events.map((event) => event.type).join(", ")}`,
                    ),
                  ),
                60_000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          events.push(...read);
          return read;
        },
        async send(message) {
          await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { message },
          });
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
  // Every line follows the one before it, and no fact is written twice.
  const lines = [...new Set(events.map(({ meta }) => meta.position.line))];
  expect(lines).toEqual(Array.from({ length: lines.length }, (_, index) => index + lines[0]!));
  const ids = {
    "call.requested": "callId",
    "model.requested": "runId",
    "turn.settled": "turnId",
    "turn.started": "turnId",
  } as const;
  for (const [type, field] of Object.entries(ids)) {
    const written = events
      .filter((event) => event.type === type)
      .map((event) => (event.data as Record<string, unknown>)[field]);
    expect(new Set(written).size, type).toBe(written.length);
  }
  return { prompts, ran, observed: seen };
}

/** The in-process host's step faults for `options`. */
function inProcessFaults(
  options: InterruptedSessionOptions,
  loses: () => boolean,
  failed: { writes: number },
): StepFaults {
  let failingWrites = options.failTurnStepWrites ?? 0;
  let failWriteOf = options.failWriteOf;
  const written = new WeakSet<StepAttempt>();
  return {
    loseCompletion: loses,
    failWrite(step, chunk) {
      const first = !written.has(step);
      written.add(step);
      const fails =
        (first && failingWrites > 0) ||
        (failWriteOf !== undefined && new TextDecoder().decode(chunk).includes(failWriteOf));
      if (!fails) return false;
      if (first && failingWrites > 0) failingWrites -= 1;
      else failWriteOf = undefined;
      failed.writes += 1;
      return true;
    },
    async retrying({ signal }) {
      if (options.holdRetryUntilStopped !== true || signal === undefined || signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  };
}
