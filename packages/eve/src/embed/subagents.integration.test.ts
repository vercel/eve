import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { codeAgentOf } from "#embed/agent.js";
import { type DefinedAgent, defineAgent } from "#public/definitions/agent.js";
import { eve } from "#definitions/defaults.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  follow,
  recorded,
  replies,
  shape,
  violations,
} from "#internal/testing/in-process-sessions.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";

// An agent defined in code delegates to the subagents it declares, as a file agent does to
// `agent/subagents/`: each is a tool, whose call runs the framework `serve` body, which opens a
// session of the subagent.

/** What a tool's result says, from the model's last prompt. */
function toolResults(prompt: readonly { readonly role: string; readonly content: unknown }[]) {
  return prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? message.content.flatMap((part: { type?: string; output?: unknown }) =>
          part.type === "tool-result" ? [JSON.stringify(part.output)] : [],
        )
      : [],
  );
}

/** Alice's release agent, which asks its `reviewer` before it replies. */
function releaseWithReviewer(): DefinedAgent {
  const reviewer = defineAgent({
    description: "Reviews a release before it ships.",
    model: markMockModel(
      new MockLanguageModelV4({
        doStream: async () => textStreamResult("The release looks good."),
        modelId: "reviewer",
        provider: "eve-test",
      }),
    ),
    modelContextWindowTokens: 200_000,
  });
  return defineAgent({
    model: markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          // The review arrives as the task's result, after the call started it.
          if (JSON.stringify(prompt).includes("The release looks good."))
            return textStreamResult("Bob's review: the release looks good.");
          return toolResults(prompt).length > 0
            ? textStreamResult("I asked the reviewer.")
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "Review the release, please." }),
                  toolCallId: "call-review",
                  toolName: "reviewer",
                },
              ]);
        },
        modelId: "release",
        provider: "eve-test",
      }),
    ),
    modelContextWindowTokens: 200_000,
    name: "release",
    subagents: { reviewer },
  });
}

describe("subagents of an agent defined in code", () => {
  it("delegates to a declared subagent on Workflow, and replies with its answer", async () => {
    const release = codeAgentOf(releaseWithReviewer());
    const test = await createTestRuntime({ agent: { name: "code-subagents-host" } });
    await test.run(async () => {
      const held = holdSessionAgent(release);
      const runtime = createWorkflowRuntime({ agent: release });
      const alice = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: "alice-code-subagents",
        runtime,
      });
      try {
        const answered = await (await alice.send("Ship the release.", { auth: null })).result();
        expect(answered.reply).toBe("Bob's review: the release looks good.");
        const events = await recorded(runtime, answered.sessionId);
        expect(events.filter(({ type }) => type === "child.opened")).toHaveLength(1);
        expect(
          events.filter(({ type }) => type === "call.settled").map(({ data }) => data),
        ).toMatchObject([{ callId: "call-review", outcome: "completed" }]);
      } finally {
        await alice.end().catch(() => {});
        held();
      }
    });
  });

  it("delegates to a declared subagent in this process as it does on Workflow", async () => {
    const release = codeAgentOf(releaseWithReviewer());
    const test = await createTestRuntime({ agent: { name: "code-subagents-in-process-host" } });
    await test.run(async () => {
      const held = holdSessionAgent(release);
      const inProcess = createInProcessRuntime({ agent: release });
      try {
        const here = await conversation(
          inProcess,
          "alice-code-subagents-here",
          "Ship the release.",
        );
        const deployed = await conversation(
          createWorkflowRuntime({ agent: release }),
          "alice-code-subagents-deployed",
          "Ship the release.",
        );
        expect(here.replies).toEqual([
          "I asked the reviewer.",
          "Bob's review: the release looks good.",
        ]);
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
        expect(shape(here.events)).toEqual(shape(deployed.events));
      } finally {
        await inProcess.dispose();
        held();
      }
    });
  }, 90_000);

  it("starts a copy of itself with the agent tool eve.defaults() lists, in this process as on Workflow", async () => {
    const copying = defineAgent({
      definitions: eve.defaults({
        without: ["bash", "read_file", "write_file", "web_fetch", "web_search"],
      }),
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const text = JSON.stringify(prompt);
            if (text.includes("Draft the notes") && !text.includes("Alice asks"))
              return textStreamResult("Draft: ship on Friday.");
            if (text.includes("Draft: ship on Friday."))
              return textStreamResult("Alice, the copy drafted: ship on Friday.");
            return toolResults(prompt).length > 0
              ? textStreamResult("A copy is drafting.")
              : toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "Draft the notes." }),
                    toolCallId: "call-copy",
                    toolName: "agent",
                  },
                ]);
          },
          modelId: "copying",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "copying",
    });
    const test = await createTestRuntime({ agent: { name: "code-agent-tool-host" } });
    await test.run(async () => {
      const held = holdSessionAgent(codeAgentOf(copying));
      const inProcess = createInProcessRuntime({ agent: codeAgentOf(copying) });
      try {
        const here = await conversation(inProcess, "alice-copy-here", "Alice asks for notes.");
        const deployed = await conversation(
          createWorkflowRuntime({ agent: codeAgentOf(copying) }),
          "alice-copy-deployed",
          "Alice asks for notes.",
        );
        expect(here.replies).toEqual([
          "A copy is drafting.",
          "Alice, the copy drafted: ship on Friday.",
        ]);
        expect(here.events.filter(({ type }) => type === "child.opened")).toHaveLength(1);
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
        expect(shape(here.events)).toEqual(shape(deployed.events));
      } finally {
        await inProcess.dispose();
        held();
      }
    });
  }, 90_000);
});

/** One message from Alice on `runtime`, followed to its turn's end. */
async function conversation(runtime: Runtime, continuationToken: string, message: string) {
  const alice = createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });
  const sent = await alice.send(message, { auth: null });
  await follow(runtime, sent.sessionId, (seen) => seen.some(({ type }) => type === "turn.settled"));
  const events = await recorded(runtime, sent.sessionId);
  return {
    events,
    replies: replies(events),
    violations: await violations(runtime, sent.sessionId),
  };
}
