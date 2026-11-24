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

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

export interface ProbeTool {
  readonly name: string;
  readonly execute?: (input: unknown) => unknown;
  readonly approval?: true;
  readonly workflow?: (...args: never[]) => unknown;
  readonly task?: true;
}

export interface ProbeOptions {
  readonly name: string;
  readonly respond: (
    prompt: string,
    call: number,
    signal: AbortSignal | undefined,
  ) => StreamResult | Promise<StreamResult>;
  readonly tools?: readonly ProbeTool[];
  readonly events?: HookDefinition["events"];
  readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
  readonly sandboxIdle?: NonNullable<Parameters<typeof createTestRuntime>[0]>["sandboxIdle"];
  readonly sessionTimeoutMs?: number;
}

export interface Probe {
  readonly test: TestRuntime;
  readonly prompts: string[];
  readonly ran: string[];
}

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
        ...(options.sessionTimeoutMs !== undefined && {
          limits: { sessionTimeoutMs: options.sessionTimeoutMs },
        }),
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
    sandboxIdle: options.sandboxIdle,
  });
  return { prompts, ran, test };
}

function workflowTool(name: string, workflow: (...args: never[]) => unknown, task: boolean) {
  const definition: Record<string, unknown> = {
    description: `Run ${name} for Alice.`,
    inputSchema: { properties: { service: { type: "string" } }, type: "object" },
  };
  definition[task ? "task" : "execute"] = workflow;
  return defineWorkflowTool(definition as never);
}

export function alice(runtime: Runtime, token: string): ReturnType<typeof createChannelAddress> {
  return createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken: token,
    runtime,
  });
}

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

export async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

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
