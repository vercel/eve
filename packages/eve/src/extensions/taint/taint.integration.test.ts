import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";

import extension, { taintPolicy, type TaintPolicyOptions } from "./extension/extension.ts";
import track from "./extension/hooks/track.ts";
import { exposure } from "./extension/lib/exposure.ts";

// One session per test: the model makes a scripted call after each tool result, and the agent-wide
// `taintPolicy()` decides each call from what the extension's hook recorded on earlier ones.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

const CHILD_TASK = "Bob asks for the open issues about the login page.";

interface ScriptedCall {
  readonly name: string;
  readonly input?: Record<string, unknown>;
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  const user = prompt.filter((message) => message.role === "user").at(-1);
  if (user === undefined) return "";
  return user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function tool(options: { tags?: readonly string[]; denied?: boolean }) {
  return defineTool({
    approval:
      options.denied === true ? () => ({ reason: "Not today.", type: "denied" }) : undefined,
    description: "Work on Alice's issues.",
    execute: () => ({ ok: true }),
    inputSchema: z.object({}),
    tags: options.tags,
  });
}

/**
 * Runs one turn whose model makes `script`'s calls in order, one per model step, then replies.
 * Settles when the turn does or a call opens an approval interaction.
 */
async function runSession(
  name: string,
  script: readonly ScriptedCall[],
  modules: readonly { readonly logicalPath: string; readonly value: unknown }[],
  policy: TaintPolicyOptions = {},
) {
  const settled: { readonly name: string; readonly outcome: string; readonly reason?: string }[] =
    [];
  const names = new Map<string, string>();
  const interactions: string[] = [];
  let outcome: string | undefined;
  let finalExposure: unknown;
  let step = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        // The `agent` tool's child shares this model; it answers without calling anything.
        if (lastUserText(prompt).includes(CHILD_TASK)) return textStreamResult("Two open issues.");
        const call = script[step];
        step++;
        if (call === undefined) return textStreamResult("Done for Alice.");
        return toolCallStreamResult({
          input: JSON.stringify(call.input ?? {}),
          toolCallId: `call-${step}`,
          toolName: call.name,
        });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        approval: taintPolicy(policy),
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      { loadNamespace: async () => ({ default: track }), logicalPath: "hooks/track.ts" },
      {
        loadNamespace: async () => ({
          default: defineHook({
            // The `agent` tool's child runs these hooks too; only the root session's count.
            events: {
              "call.requested": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                names.set(event.data.callId, event.data.capability.name);
              },
              "call.settled": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                settled.push({
                  name: names.get(event.data.callId) ?? event.data.callId,
                  outcome: event.data.outcome,
                  ...(event.data.error !== undefined && { reason: event.data.error.message }),
                });
              },
              "interaction.opened": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                interactions.push(event.data.interactionId);
                finalExposure = exposure.get();
              },
              "turn.settled": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                outcome = event.data.outcome;
                finalExposure = exposure.get();
              },
            },
          }),
        }),
        logicalPath: "hooks/observe.ts",
      },
      ...modules.map(({ logicalPath, value }) => ({
        loadNamespace: async () => ({ default: value }),
        logicalPath,
      })),
    ],
  });

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        input: { message: "Alice asks to triage her issues and tell the team." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
      },
    ]);
    try {
      await until(
        () => outcome !== undefined || interactions.length > 0,
        () => `step ${step}, settled ${JSON.stringify(settled)}`,
      );
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { exposure: finalExposure, interactions, outcome, settled };
}

const readIssue = {
  logicalPath: "tools/read_issue.ts",
  value: tool({ tags: ["reads:untrusted"] }),
};
const sendEmail = {
  logicalPath: "tools/send_email.ts",
  value: tool({ tags: ["effect:external"] }),
};

describe("eve/extensions/taint", () => {
  it("asks before an external effect once the session read untrusted content", async () => {
    extension({});

    const result = await runSession(
      "taint-external",
      [{ name: "read_issue" }, { name: "send_email" }],
      [readIssue, sendEmail],
    );

    expect(result.settled).toEqual([{ name: "read_issue", outcome: "completed" }]);
    expect(result.interactions).toHaveLength(1);
    expect(result.exposure).toMatchObject({ exposed: true, sources: ["read_issue"] });
  }, 90_000);

  it("denies an export once the session read untrusted content", async () => {
    extension({});

    const result = await runSession(
      "taint-export",
      [{ name: "read_issue" }, { name: "share_doc" }],
      [readIssue, { logicalPath: "tools/share_doc.ts", value: tool({ tags: ["effect:export"] }) }],
    );

    expect(result.interactions).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.settled).toEqual([
      { name: "read_issue", outcome: "completed" },
      {
        name: "share_doc",
        outcome: "rejected",
        reason: expect.stringContaining("read untrusted content from read_issue"),
      },
    ]);
  }, 90_000);

  it("doesn't expose the session for an untrusted call that was rejected", async () => {
    extension({});

    const result = await runSession(
      "taint-rejected",
      [{ name: "read_issue" }, { name: "send_email" }],
      [
        {
          logicalPath: "tools/read_issue.ts",
          value: tool({ denied: true, tags: ["reads:untrusted"] }),
        },
        sendEmail,
      ],
    );

    expect(result.interactions).toEqual([]);
    expect(result.settled).toEqual([
      { name: "read_issue", outcome: "rejected", reason: expect.any(String) },
      { name: "send_email", outcome: "completed" },
    ]);
    expect(result.exposure).toMatchObject({ exposed: false, pending: {} });
  }, 90_000);

  // The built-in `agent` tool stands in for a subagent: the in-memory runtime can't author one,
  // and a subagent tagged `reads:untrusted` reaches the hook the same way (#5871 covers its tags).
  it("exposes a parent through the subagent it called, once the subagent's result is in", async () => {
    extension({});

    const result = await runSession(
      "taint-subagent",
      [
        { input: { message: CHILD_TASK }, name: "agent" },
        // The child runs as a task; the parent reads its result once the task settles the call.
        { name: "eve__task_wait" },
        { name: "send_email" },
      ],
      [sendEmail],
    );

    expect(result.settled[0]).toMatchObject({ name: "agent", outcome: "completed" });
    expect(result.interactions).toHaveLength(1);
    expect(result.exposure).toMatchObject({ exposed: true, sources: ["agent"] });
  }, 90_000);

  it("marks exposure from the policy at request time with markOnRequest, even for a denied call", async () => {
    extension({});

    const result = await runSession(
      "taint-mark-on-request",
      [{ name: "read_issue" }, { name: "send_email" }],
      [
        {
          logicalPath: "tools/read_issue.ts",
          value: tool({ denied: true, tags: ["reads:untrusted"] }),
        },
        sendEmail,
      ],
      { markOnRequest: true },
    );

    // The policy's write outlives its step: the next step's call sees it.
    expect(result.settled).toEqual([
      { name: "read_issue", outcome: "rejected", reason: expect.any(String) },
    ]);
    expect(result.interactions).toHaveLength(1);
    expect(result.exposure).toMatchObject({ exposed: true, sources: ["read_issue"] });
  }, 90_000);

  it("asks nothing in a session that read nothing untrusted", async () => {
    extension({});

    const result = await runSession(
      "taint-clean",
      [{ name: "list_labels" }, { name: "send_email" }],
      [{ logicalPath: "tools/list_labels.ts", value: tool({}) }, sendEmail],
    );

    expect(result.interactions).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.settled.map(({ outcome }) => outcome)).toEqual(["completed", "completed"]);
    expect(result.exposure).toMatchObject({ exposed: false, sources: [] });
  }, 90_000);
});
