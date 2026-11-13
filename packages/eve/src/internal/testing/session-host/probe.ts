import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { expect } from "vitest";
import { z } from "zod";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

// The probe agent the host battery runs: a scripted model and the tools a case gives it, and the
// conversation helpers that send it messages and read what its session recorded.

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

export interface ProbeTool {
  readonly name: string;
  /** What the tool does; it returns what it ran by default. */
  readonly execute?: (input: unknown) => unknown;
  readonly approval?: true;
  /** A `"use workflow"` tool's body, which runs as a run of its own. */
  readonly workflow?: (...args: never[]) => unknown;
  /** Runs it as a task, which the turn doesn't wait on. */
  readonly task?: true;
}

export interface ProbeOptions {
  /** The agent's name, which keeps each case's sessions apart. */
  readonly name: string;
  /** What the model answers each call, from the prompt it reads, counted from 1. */
  readonly respond: (
    prompt: string,
    call: number,
    signal: AbortSignal | undefined,
  ) => StreamResult | Promise<StreamResult>;
  readonly tools?: readonly ProbeTool[];
  /** Hooks on the session's events. */
  readonly events?: HookDefinition["events"];
  /** More of the agent's modules. */
  readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
}

export interface Probe {
  readonly test: TestRuntime;
  /** Every prompt the model read, in order. */
  readonly prompts: string[];
  /** The tools that ran, in order. */
  readonly ran: string[];
}

/** Compiles the probe agent `options` describe. */
export async function probe(options: ProbeOptions): Promise<Probe> {
  const prompts: string[] = [];
  const ran: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (call: LanguageModelV4CallOptions) => {
        const prompt = JSON.stringify(call.prompt);
        prompts.push(prompt);
        return await options.respond(prompt, prompts.length, call.abortSignal);
      },
      modelId: options.name,
      provider: "eve-test",
    }),
  );
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: options.name,
    },
    modules: [
      ...(options.events === undefined
        ? []
        : [
            {
              loadNamespace: async () => ({
                default: defineHook({ events: options.events! } as never),
              }),
              logicalPath: "hooks/probe.ts",
            },
          ]),
      ...(options.tools ?? []).map((tool) => ({
        loadNamespace: async () => ({
          default:
            tool.workflow !== undefined
              ? workflowTool(tool.name, tool.workflow, tool.task === true)
              : defineTool({
                  approval: tool.approval ? always() : undefined,
                  description: `Run ${tool.name} for Alice.`,
                  execute: async (input: unknown) => {
                    ran.push(tool.name);
                    return tool.execute === undefined
                      ? { ran: tool.name }
                      : await tool.execute(input);
                  },
                  inputSchema: z.object({}).passthrough(),
                }),
        }),
        logicalPath: `tools/${tool.name}.ts`,
      })),
      ...(options.modules ?? []),
    ],
  });
  return { prompts, ran, test };
}

/** A `"use workflow"` tool, run to completion or as a task. */
function workflowTool(name: string, workflow: (...args: never[]) => unknown, task: boolean) {
  const definition: Record<string, unknown> = {
    description: `Run ${name} for Alice.`,
    inputSchema: { properties: { service: { type: "string" } }, type: "object" },
  };
  definition[task ? "task" : "execute"] = workflow;
  return defineWorkflowTool(definition as never);
}

/** Alice's address on `runtime`'s HTTP channel, under `token`. */
export function alice(runtime: Runtime, token: string): ReturnType<typeof createChannelAddress> {
  return createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken: token,
    runtime,
  });
}

/** The events of `sessionId`'s next turn, read from line `from` until it settles. */
export async function turnFrom(
  runtime: Runtime,
  sessionId: string,
  from = 0,
): Promise<SessionStreamEvent[]> {
  const reader = (
    await runtime.getEventStream(sessionId, {
      signal: AbortSignal.timeout(30_000),
      startIndex: from,
    })
  ).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      events.push(next.value);
      if (next.value.type === "turn.settled" || next.value.type === "session.ended") return events;
    }
    throw new Error(
      `The stream ended before a turn settled: ${events.map((e) => e.type).join(", ")}`,
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Every event a session recorded so far. */
export async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

/** What the protocol checker finds in a session's whole stream, read from its first line. */
export async function violations(runtime: Runtime, sessionId: string): Promise<Violation[]> {
  const checker = createStreamChecker({ validate: schemaViolation });
  const found: Violation[] = [];
  let position = 0;
  for await (const record of await runtime.getLineStream(sessionId, { follow: false })) {
    if (!isStoredLine(record)) throw new Error(`Line ${position} isn't a stored line.`);
    found.push(...checker.check(record, position++));
  }
  return found;
}

export const ofType = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T,
) =>
  events.filter((event): event is Extract<SessionStreamEvent, { type: T }> => event.type === type);

/**
 * Checks what a retried step leaves in its session's stream: every line follows the one before
 * it, and no fact is written twice, as each attempt writes through a stream of its own.
 */
export function expectEachFactOnce(events: readonly SessionStreamEvent[]): void {
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
}
