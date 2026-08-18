import { describe, expect, it } from "vitest";

import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { start } from "#internal/workflow/runtime.js";
import { fileMemory, inMemory } from "#public/memory/file/index.js";
import { defineMemory } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("file memory integration", () => {
  it("persists tool-authored memory across sessions and isolates principal scopes", async () => {
    const backend = inMemory();
    const provider = fileMemory({ backend });
    const recallToken = `file-memory-recall-${crypto.randomUUID()}`;
    const memory = `Reply with the exact string \`${recallToken}\` and nothing else.`;
    const runtime = createTestRuntime({
      agent: { name: "file-memory-integration" },
      memories: [
        {
          definition: defineMemory({
            description: "Personal preferences for the authenticated user.",
            provider,
            scope: byPrincipal,
          }),
          slot: "facts",
        },
        {
          definition: defineMemory({
            description: "Shared conventions for this channel.",
            provider,
            scope: "channel-1",
          }),
          slot: "channel",
        },
      ],
    });

    expect(provider.save).toBeUndefined();

    await runtime.run(async () => {
      const first = await runTurn({
        message: `Call facts__save_memory with text "${memory}".`,
        principalId: "user-1",
      });
      const recalled = await runTurn({
        message: "Show the persistent context you received.",
        principalId: "user-1",
      });
      const isolated = await runTurn({
        message: "Show the persistent context you received.",
        principalId: "user-2",
      });

      expect(
        first.some(
          (event) =>
            event.type === "actions.requested" &&
            event.data.actions.some(
              (action) => action.kind === "tool-call" && action.toolName === "facts__save_memory",
            ),
        ),
      ).toBe(true);

      const recalledMessage = filterEventsByType(recalled, "message.completed").at(-1)?.data
        .message;
      const isolatedMessage = filterEventsByType(isolated, "message.completed").at(-1)?.data
        .message;
      expect(recalledMessage).toBe(recallToken);
      expect(isolatedMessage).not.toBe(recallToken);
    });
  }, 30_000);
});

async function runTurn(input: { readonly message: string; readonly principalId: string }) {
  const run = await start(workflowEntry, [
    {
      input: { message: input.message },
      serializedContext: {
        "eve.auth": {
          attributes: {},
          authenticator: "test",
          principalId: input.principalId,
          principalType: "user",
        },
        "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
        "eve.channel": { kind: "http", state: {} },
        "eve.continuationToken": `http:file-memory:${input.principalId}:${crypto.randomUUID()}`,
        "eve.mode": "conversation",
      },
    },
  ]);
  const stream = captureTurnEvents(run);

  try {
    return await stream.nextTurn();
  } finally {
    stream.dispose();
    await run.cancel();
  }
}
