import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { readStoredTurnState } from "#internal/testing/session-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/instructions/index.js";
import { defineMemory, defineMemoryProvider } from "#public/memory/index.js";
import { defineSkill } from "#public/skills/index.js";
import { defineDynamic as defineDynamicConnection } from "#public/definitions/connections/dynamic.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { attachToolBehavior, readToolBehavior } from "#tools/behavior.js";
import { agent as agentTool } from "#tools/framework/agent.js";

// What eve sends the model, and what a session stores, for representative agents: the oracle for
// changes to how a model call is assembled. These compare normalized prompts and tool names,
// not full provider requests or object key order; stored state records the checkpoint shape.
// Run with `-u` to accept a deliberate change, and review the golden diff.

type Respond = (
  options: LanguageModelV4CallOptions,
  n: number,
) => ReturnType<typeof textStreamResult>;

function recordingModel(respond: Respond) {
  const calls: { readonly prompt: unknown; readonly tools: readonly string[] }[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push({
          prompt: options.prompt,
          tools: (options.tools ?? []).map((tool) => tool.name),
        });
        return respond(options, calls.length);
      },
      modelId: "layout",
      provider: "eve-test",
    }),
  );
  return { calls, model };
}

const mod = (logicalPath: string, value: unknown) => ({
  loadNamespace: async () => ({ default: value }),
  logicalPath,
});

const address = (runtime: Runtime, continuationToken: string) =>
  createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });

const dynamicModel = (model: unknown) =>
  defineAgent({
    model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
  } as never);

/**
 * Replaces generated values with stable placeholders, numbered by first appearance, so two runs
 * compare equal: ids, times, digests, durations.
 */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  const placeholder = (kind: string, raw: string) => {
    // Times collide within a millisecond, so numbering them would vary run to run.
    if (kind === "time") return "<time>";
    const key = `${kind}:${raw}`;
    if (!seen.has(key))
      seen.set(key, `<${kind}${[...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length}>`);
    return seen.get(key)!;
  };
  const patterns: readonly [string, RegExp][] = [
    ["time", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g],
    ["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
    ["ulid", /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/g],
    ["request", /(?<=requestId\\?"\s*:\s*\\?")[A-Za-z0-9_-]{12,32}/g],
    ["id", /\b(?:sess|turn|req|call|del|int|task|agent|run|wrun|step|msg|evt)_[A-Za-z0-9]{8,}\b/g],
    ["id", /\b(?:agent|task|deploy)-[a-z0-9]{6,}\b/g],
  ];
  const rewrite = (text: string) =>
    patterns.reduce(
      (out, [kind, pattern]) => out.replace(pattern, (raw) => placeholder(kind, raw)),
      text,
    );
  const visit = (entry: unknown, key: string): unknown => {
    if (typeof entry === "string") {
      if (key === "eveVersion") return "<eveVersion>";
      const text = rewrite(entry);
      if (/(?:^|[a-z])(?:Ms|At|Time)$/.test(key) && /^\d+$/.test(text)) return `<${key}>`;
      return text;
    }
    if (typeof entry === "number" && /(?:Ms|At|Time|durationMs|startedAt)$/.test(key))
      return `<${key}>`;
    if (Array.isArray(entry)) return entry.map((item) => visit(item, key));
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([field, item]) => [rewrite(field), visit(item, field)]),
      );
    }
    return entry;
  };
  return visit(value, "");
}

/** The state the session's last turn step stored, with generated values replaced. */
async function storedState(sessionId: string): Promise<unknown> {
  return normalize(await readStoredTurnState(sessionId));
}

async function golden(name: string, value: unknown): Promise<void> {
  await expect(`${JSON.stringify(normalize(value), null, 2)}\n`).toMatchFileSnapshot(
    `./__golden__/request-layout/${name}.json`,
  );
}

async function onWorkflow<T>(fn: (runtime: Runtime) => Promise<T>): Promise<T> {
  return await fn(
    createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  );
}

describe("what eve sends the model", () => {
  it("assembles instructions, tools, an approval that waits through a message, and a compaction", async () => {
    const script: Respond[] = [
      () => toolCallStreamResult({ input: "{}", toolCallId: "call-lookup", toolName: "lookup" }),
      () => textStreamResult("Three changes."),
      () => toolCallStreamResult({ input: "{}", toolCallId: "call-deploy", toolName: "deploy" }),
      () => textStreamResult("Noted, Bob."),
      () => textStreamResult("Deployed."),
      () => textStreamResult("Summary of the conversation so far."),
      () => textStreamResult("Yes."),
    ];
    const { calls, model } = recordingModel((options, n) => script[n - 1]!(options, n));
    const test = await createTestRuntime({
      agent: { definition: dynamicModel(model), name: "layout-release" },
      modules: [
        mod(
          "instructions/agent.ts",
          defineInstructions({ content: "You are Ada, a release assistant." }),
        ),
        mod(
          "instructions/brief.ts",
          defineInstructions({ content: "Release brief: v2.3 ships Friday.", role: "user" }),
        ),
        mod(
          "instructions/today.ts",
          defineDynamic(() => defineInstructions({ content: "Today is Thursday." })),
        ),
        mod(
          "instructions/viewer.ts",
          defineDynamic(() =>
            defineInstructions({ content: "Alice is on the release team.", role: "user" }),
          ),
        ),
        mod(
          "tools/lookup.ts",
          defineTool({
            description: "Look up a change.",
            execute: async () => ({ changes: 3 }),
            inputSchema: {},
          }),
        ),
        mod(
          "skills/rollback.ts",
          defineSkill({
            content: "Revert the release tag, then redeploy the previous build.",
            description: "Roll a release back.",
            files: { "references/checklist.md": "# Rollback checklist\n" },
          }),
        ),
        mod(
          "tools/deploy.ts",
          defineTool({
            approval: always(),
            description: "Deploy.",
            execute: async () => ({ deployed: true }),
            inputSchema: {},
          }),
        ),
      ],
    });
    await test.run(() =>
      onWorkflow(async (runtime) => {
        const alice = address(runtime, "layout-release");
        const first = await (await alice.send("What's in the release?", { auth: null })).result();
        const asked = await (await alice.send("Deploy it.", { auth: null })).result();
        const mid = await (
          await alice.send("Bob: hold on until QA signs off.", { auth: null })
        ).result();
        const open = [...asked.interactions, ...mid.interactions].filter(
          (i) => i.status === "open",
        );
        await (
          await alice.deliver(
            { answers: [{ interactionId: open[0]!.interactionId, optionId: "approve" }] },
            { auth: null },
          )
        ).result();
        await runtime.dispatchSession({
          command: { deliveryId: "layout-release-compact", kind: "compact" },
          sessionId: first.sessionId,
        });
        await (await alice.send("Did it ship?", { auth: null })).result();
        await golden("release.requests", calls);
        await golden("release.state", await storedState(first.sessionId));
      }),
    );
  });

  it("anchors memory recall before each turn's input and keeps it across a compaction", async () => {
    const { calls, model } = recordingModel((options) => {
      const text = JSON.stringify(options.prompt);
      if (text.includes("CHECKPOINT")) return textStreamResult("Alice asked about QA; it passed.");
      if (text.includes("Is it out?")) return textStreamResult("Yes.");
      return textStreamResult("QA passed.");
    });
    const test = await createTestRuntime({
      agent: { definition: dynamicModel(model), name: "layout-memory" },
      modules: [
        mod(
          "instructions/agent.ts",
          defineInstructions({ content: "You are Ada, a release assistant." }),
        ),
        mod(
          "memory/team.ts",
          defineMemory({
            namespace: "layout-memory",
            provider: defineMemoryProvider({
              recall: {
                "turn.started": async () => ({
                  messages: [{ content: "Alice prefers short answers.", id: "pref" }],
                }),
              },
            }),
            scope: () => "team",
          }),
        ),
      ],
    });
    await test.run(() =>
      onWorkflow(async (runtime) => {
        const alice = address(runtime, "layout-memory");
        const first = await (await alice.send("Did QA pass?", { auth: null })).result();
        await runtime.dispatchSession({
          command: { deliveryId: "layout-memory-compact", kind: "compact" },
          sessionId: first.sessionId,
        });
        await (await alice.send("Is it out?", { auth: null })).result();
        await golden("memory.requests", calls);
        await golden("memory.state", await storedState(first.sessionId));
      }),
    );
  });

  it.each([false, true])(
    "reports a background task's listing and result to the dynamic model and its call (failed evaluation: %s)",
    async (failEvaluation) => {
      let dynamicMessages = "";
      let failedPreview: string | undefined;
      const name = failEvaluation ? "layout-tasks-recovery" : "layout-tasks";
      const rootCalls: { dynamicMessages: string; modelMessages: string }[] = [];
      const projections: unknown[] = [];
      const { calls, model } = recordingModel((options) => {
        const all = JSON.stringify(options.prompt.filter((message) => message.role !== "system"));
        if (!all.includes("Did QA pass?")) return textStreamResult("QA passed.");
        rootCalls.push({ dynamicMessages, modelMessages: all });
        if (all.includes("<task_result id=")) {
          return textStreamResult("QA passed, so we can ship.");
        }
        if (options.prompt.some((message) => message.role === "tool"))
          return textStreamResult("QA is still being checked.");
        return toolCallStreamResult({
          input: JSON.stringify({ message: "Check the QA status." }),
          toolCallId: "call-agent",
          toolName: "agent",
        });
      });
      const test = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(async (ctx) => {
              if (ctx.session.parent === undefined) {
                dynamicMessages = JSON.stringify(await ctx.messages());
                if (
                  failEvaluation &&
                  failedPreview === undefined &&
                  dynamicMessages.includes("<task_result id=")
                ) {
                  failedPreview = dynamicMessages;
                  throw new Error("Could not choose the model for the QA result.");
                }
              }
              return { model, modelContextWindowTokens: 200_000 };
            }),
          } as never),
          name,
        },
        modules: [
          mod(
            "tools/agent.ts",
            attachToolBehavior(
              {
                ...agentTool,
                toModelOutput: (output: unknown) => {
                  projections.push(output);
                  // A second projection of this delivery would produce different prompt text.
                  return {
                    type: "text" as const,
                    value:
                      projections.length === 1
                        ? "QA passed."
                        : `QA passed. (projection ${projections.length})`,
                  };
                },
              },
              readToolBehavior(agentTool)!,
            ),
          ),
          mod(
            "instructions/agent.ts",
            defineInstructions({ content: "You are Ada, a release assistant." }),
          ),
        ],
      });
      await test.run(async () => {
        // Background tasks run as durable runs, which only the Workflow host offers.
        const runtime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const alice = address(runtime, name);
        await (await alice.send("Did QA pass?", { auth: null })).result();
        if (failEvaluation) {
          await (await alice.send("Please share the QA result.", { auth: null })).result();
        }
      });
      expect(
        rootCalls.some(({ modelMessages }) => modelMessages.includes("<task_result id=")),
      ).toBe(true);
      for (const { dynamicMessages, modelMessages } of rootCalls) {
        for (const pattern of [
          /\[Tasks\][\s\S]*?<\/tasks>(?:\\n<idle>[\s\S]*?<\/idle>)?/g,
          /<task_result id=[\s\S]*?<\/task_result>/g,
        ]) {
          expect(dynamicMessages.match(pattern) ?? []).toEqual(modelMessages.match(pattern) ?? []);
        }
      }
      expect(projections).toHaveLength(failEvaluation ? 2 : 1);
      if (failEvaluation) {
        expect(failedPreview).toContain("<task_result id=");
        expect(failedPreview).toContain("QA passed.");
        expect(rootCalls.at(-1)?.modelMessages).toContain("QA passed. (projection 2)");
      } else {
        await golden("tasks.requests", calls);
      }
    },
  );

  it("lists the agent's connections, static and dynamic, behind eve's catalog tools", async () => {
    const { calls, model } = recordingModel(() =>
      textStreamResult("I can reach Linear and Notion."),
    );
    const test = await createTestRuntime({
      agent: { definition: dynamicModel(model), name: "layout-connections" },
      modules: [
        mod(
          "instructions/agent.ts",
          defineInstructions({ content: "You are Ada, a release assistant." }),
        ),
        mod(
          "connections/linear.ts",
          defineMcpClientConnection({
            description: "Linear issues for the release team.",
            url: "https://mcp.linear.example/mcp",
          }),
        ),
        mod(
          "connections/notion.ts",
          defineDynamicConnection(() =>
            defineMcpClientConnection({
              description: "Alice's Notion workspace.",
              url: "https://mcp.notion.example/mcp",
            }),
          ),
        ),
      ],
    });
    await test.run(() =>
      onWorkflow(async (runtime) => {
        const alice = address(runtime, "layout-connections");
        const first = await (await alice.send("What can you reach?", { auth: null })).result();
        await (await alice.send("Thanks.", { auth: null })).result();
        await golden("connections.requests", calls);
        await golden("connections.state", await storedState(first.sessionId));
      }),
    );
  });
});
