import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput } from "#channel/types.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createTemporalLoopRuntime } from "./runtime.js";

const ADAPTER: ChannelAdapter = { kind: "http" };

describe("TemporalLoopRuntime", () => {
  it("runs the production one-tool loop through a child Workflow and rekeys after it completes", async () => {
    let toolExecutions = 0;
    const tool = mockTool({
      description: "Echo the nonce so the loop runs exactly one tool call.",
      execute(rawInput) {
        toolExecutions += 1;
        const nonce = readNonce(rawInput);
        return `loop-verified:${nonce}`;
      },
      inputSchema: {
        additionalProperties: false,
        properties: { nonce: { type: "string" } },
        required: ["nonce"],
        type: "object",
      },
      name: "loop_echo",
    });
    const app = createTestRuntime({
      agent: { name: "temporal-loop" },
      tools: [tool],
    });
    const manifestTool = app.manifest.tools.find((candidate) => candidate.name === tool.name);
    if (manifestTool === undefined) throw new Error("loop_echo is missing from the manifest.");
    app.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
      default: { execute: tool.execute },
    };

    await app.run(async () => {
      const runtime = await createTemporalLoopRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      try {
        const handle = await runtime.run(createRunInput());
        const events = await readThroughWaiting(handle.events);

        expect(events.at(-1)?.type).toBe("session.waiting");
        expect(events.filter((event) => event.type === "step.completed")).toHaveLength(2);
        const requests = events.filter((event) => event.type === "actions.requested");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.data.actions).toEqual([
          {
            callId: "call_loop_echo",
            input: { nonce: "nonce-123" },
            kind: "tool-call",
            toolName: "loop_echo",
          },
        ]);
        const messages = events.filter((event) => event.type === "message.appended");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.data.messageSoFar).toBe(
          'Used loop_echo for "Use loop_echo exactly once with nonce "nonce-123".": loop-verified:nonce-123',
        );
        expect(toolExecutions).toBe(1);

        const history = await waitForRekeyHistory(runtime, handle.sessionId);
        expect(history.childWorkflowsStarted).toBe(1);
        expect(history.rekeyScheduledAfterChildCompletion).toBe(true);
        expect(history.scheduledActivityTypes).toEqual(
          expect.arrayContaining(["createSession", "rekeySession"]),
        );
        expect(history.scheduledActivityTypes).not.toContain("settleSession");
      } finally {
        await runtime.close();
      }
    });
  });
});

function createRunInput(): RunInput {
  return {
    adapter: ADAPTER,
    auth: null,
    capabilities: { requestInput: true },
    continuationToken: "http:temporal-loop",
    input: {
      message: 'Use loop_echo exactly once with nonce "nonce-123".',
    },
    mode: "conversation",
    requestId: "temporal-scenario-sample",
  };
}

function readNonce(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("nonce" in value) ||
    typeof value.nonce !== "string"
  ) {
    throw new TypeError("loop_echo requires a string nonce.");
  }
  return value.nonce;
}

async function readThroughWaiting(
  stream: ReadableStream<HandleMessageStreamEvent>,
): Promise<readonly HandleMessageStreamEvent[]> {
  const reader = stream.getReader();
  const events: HandleMessageStreamEvent[] = [];
  try {
    while (true) {
      const next = await withTimeout(reader.read(), "Temporal loop runtime event stream");
      if (next.done) throw new Error("Temporal loop runtime stream closed before session.waiting.");
      events.push(next.value);
      if (next.value.type === "session.waiting") return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function waitForRekeyHistory(
  runtime: Awaited<ReturnType<typeof createTemporalLoopRuntime>>,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof runtime.inspectHistory>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const history = await runtime.inspectHistory(sessionId);
    if (history.rekeyScheduledAfterChildCompletion) return history;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Temporal history did not record rekey after child completion.");
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
