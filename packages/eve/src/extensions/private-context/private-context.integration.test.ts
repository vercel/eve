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

import { privateContext } from "./extension/extension.ts";
import track from "./extension/hooks/track.ts";
import { personal } from "./extension/lib/personal.ts";

// One session per test: the model makes a scripted call after each tool result, and the agent-wide
// `privateContext()` decides each call from the session's audience and what the hook recorded.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

const CHILD_TASK = "Alice asks for her notes about the launch.";

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

function tool(options: { tags?: readonly string[]; fails?: boolean }) {
  return defineTool({
    description: "Work with Alice's notes.",
    execute: () => {
      if (options.fails === true) throw new Error("Alice's workspace refused the request.");
      return { notes: "Launch moved to Friday." };
    },
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
  audience: "public" | "private" | "unknown" = "private",
) {
  const settled: { readonly name: string; readonly outcome: string; readonly reason?: string }[] =
    [];
  const names = new Map<string, string>();
  const interactions: string[] = [];
  let outcome: string | undefined;
  let finalState: unknown;
  let step = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        // The `agent` tool's child shares this model; it answers without calling anything.
        if (lastUserText(prompt).includes(CHILD_TASK)) return textStreamResult("Launch is Friday.");
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
        approval: privateContext(),
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
                  ...(event.data.outcome === "rejected" &&
                    event.data.error !== undefined && { reason: event.data.error.message }),
                });
              },
              "interaction.opened": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                interactions.push(event.data.interactionId);
                finalState = personal.get();
              },
              "turn.settled": (event, ctx) => {
                if (ctx.session.parent !== undefined) return;
                outcome = event.data.outcome;
                finalState = personal.get();
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
        input: { message: "Alice asks to summarize her notes and share them." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          audience,
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
  return { interactions, outcome, settled, state: finalState };
}

const notionSearch = {
  logicalPath: "tools/notion_search.ts",
  value: tool({ tags: ["reads:personal"] }),
};
const postToSlack = {
  logicalPath: "tools/post_to_slack.ts",
  value: tool({ tags: ["effect:external"] }),
};

describe("eve/extensions/private-context", () => {
  it("asks before a write once the session read someone's personal data", async () => {
    const result = await runSession(
      "private-context-write",
      [{ name: "notion_search" }, { name: "post_to_slack" }],
      [notionSearch, postToSlack],
    );

    expect(result.settled).toEqual([{ name: "notion_search", outcome: "completed" }]);
    expect(result.interactions).toHaveLength(1);
    expect(result.state).toMatchObject({
      caller: "alice",
      owners: ["alice"],
      sources: ["notion_search"],
    });
  }, 90_000);

  it("sends personal data back to its owner, but asks before it reaches an internal sink", async () => {
    const result = await runSession(
      "private-context-within-caps",
      [
        { name: "notion_search" },
        { name: "send_dm" },
        { name: "wiki_search" },
        { name: "post_to_team" },
      ],
      [
        notionSearch,
        {
          logicalPath: "tools/send_dm.ts",
          value: tool({ tags: ["effect:external", "sink:user"] }),
        },
        { logicalPath: "tools/wiki_search.ts", value: tool({ tags: ["reads:sensitive"] }) },
        {
          logicalPath: "tools/post_to_team.ts",
          value: tool({ tags: ["effect:external", "sink:internal"] }),
        },
      ],
    );

    expect(result.interactions).toHaveLength(1);
    expect(result.settled).toEqual([
      { name: "notion_search", outcome: "completed" },
      { name: "send_dm", outcome: "completed" },
      { name: "wiki_search", outcome: "completed" },
    ]);
  }, 90_000);

  it("doesn't ask after a personal read that failed", async () => {
    const result = await runSession(
      "private-context-failed",
      [{ name: "notion_search" }, { name: "post_to_slack" }],
      [
        {
          logicalPath: "tools/notion_search.ts",
          value: tool({ fails: true, tags: ["reads:personal"] }),
        },
        postToSlack,
      ],
    );

    expect(result.interactions).toEqual([]);
    expect(result.settled).toEqual([
      { name: "notion_search", outcome: "failed" },
      { name: "post_to_slack", outcome: "completed" },
    ]);
    expect(result.state).toMatchObject({ owners: [], pending: {}, sources: [] });
  }, 90_000);

  // The built-in `agent` tool stands in for a subagent: the in-memory runtime can't author one,
  // and a subagent tagged `reads:personal` reaches the hook the same way (#5871 covers its tags).
  it("asks before the parent's next write after a subagent that can read personal data", async () => {
    const result = await runSession(
      "private-context-subagent",
      [
        { input: { message: CHILD_TASK }, name: "agent" },
        // The child runs as a task; the parent reads its result once the task settles the call.
        { name: "eve__task_wait" },
        { name: "post_to_slack" },
      ],
      [postToSlack],
    );

    expect(result.settled[0]).toMatchObject({ name: "agent", outcome: "completed" });
    expect(result.interactions).toHaveLength(1);
    expect(result.state).toMatchObject({ owners: ["alice"], sources: ["agent"] });
  }, 90_000);

  it.each(["public", "unknown"] as const)(
    "rejects a personal read when the audience is %s",
    async (audience) => {
      const result = await runSession(
        `private-context-${audience}`,
        [{ name: "notion_search" }],
        [notionSearch],
        audience,
      );

      expect(result.interactions).toEqual([]);
      expect(result.outcome).toBe("completed");
      expect(result.settled).toEqual([
        {
          name: "notion_search",
          outcome: "rejected",
          reason: expect.stringContaining("This conversation is visible outside its participants"),
        },
      ]);
    },
    90_000,
  );

  it("runs a personal read in a private conversation", async () => {
    const result = await runSession(
      "private-context-private",
      [{ name: "notion_search" }],
      [notionSearch],
      "private",
    );

    expect(result.outcome).toBe("completed");
    expect(result.settled).toEqual([{ name: "notion_search", outcome: "completed" }]);
  }, 90_000);
});
