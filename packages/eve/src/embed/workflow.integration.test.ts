import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { codeAgentOf } from "#embed/agent.js";
import { defineAgent } from "#public/definitions/agent.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { lookupSessionOwnerHook } from "#execution/session-inbox/owner.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";

// On Workflow a compacted session moves to a successor run, so no one run's event log grows with
// the session. The successor checks that it can make the session's agent, which for an agent
// defined in code is the one this process holds: if it refused, the owner would keep the session
// after three failed activations, and the conversation would go on without the handoff.

const purposes: string[] = [];

const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = JSON.stringify(prompt);
      if (text.includes("CONTEXT CHECKPOINT COMPACTION")) {
        purposes.push("compaction");
        return textStreamResult("Alice shared her release notes.");
      }
      purposes.push("turn");
      return textStreamResult(
        text.includes("Alice shared her release notes")
          ? "You shared your release notes."
          : "Noted.",
      );
    },
    modelId: "workflow-code-agent",
    provider: "eve-test",
  }),
);

describe("an agent defined in code, on Workflow", () => {
  it("hands a compacted session to a successor run, which goes on from the summary", async () => {
    const notes = defineAgent({
      model,
      modelContextWindowTokens: 200_000,
      name: "handoff-notes",
    });
    const test = await createTestRuntime({ agent: { name: "workflow-code-agent-host" } });
    await test.run(async () => {
      const release = holdSessionAgent(codeAgentOf(notes));
      const alice = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: "alice-code-agent-handoff",
        runtime: createWorkflowRuntime({ agent: codeAgentOf(notes) }),
      });
      try {
        const first = await (
          await alice.send("Here are my release notes.", { auth: null })
        ).result();
        expect(first.reply).toBe("Noted.");

        const compacted = await (await alice.compact()).result();
        expect(compacted.status).toBe("completed");
        const inbox = sessionInboxHookToken(sessionCommandHookToken(first.sessionId));
        await vi.waitFor(
          async () => expect((await lookupSessionOwnerHook(inbox)).runId).not.toBe(first.sessionId),
          { timeout: 10_000 },
        );

        const next = await (await alice.send("What did I share?", { auth: null })).result();
        expect(next.sessionId).toBe(first.sessionId);
        expect(next.reply).toBe("You shared your release notes.");
        expect(purposes).toEqual(["turn", "compaction", "turn"]);
      } finally {
        await alice.end().catch(() => {});
        release();
      }
    });
  });
});
