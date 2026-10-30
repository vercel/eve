import { expect, it, vi } from "vitest";

import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { recordRemoteChildBinding } from "#execution/child-binding.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { DynamicRemoteBinding } from "#reactions/remote.js";

vi.mock("#execution/child-binding.js", () => ({ recordRemoteChildBinding: vi.fn() }));
vi.mock("#execution/publish-session-events.js", async (importOriginal) => ({
  ...(await importOriginal()),
  publishSessionEvents: vi.fn(
    async (target: { serializedContext: Record<string, unknown>; sessionState: unknown }) => ({
      cancelled: false,
      serializedContext: target.serializedContext,
      sessionState: target.sessionState,
    }),
  ),
}));

it("records a dynamic remote child's opening binding for the parent's stream proxy", async () => {
  // Alice opened the child as Acme; the proxy renders its credentials from this binding alone.
  const opening: DynamicRemoteBinding = {
    at: "2026-01-01T00:00:00.000Z",
    channel: { kind: "unknown", metadata: {} },
    memos: { "tenant-digest": "acme" },
    position: 3,
    session: { auth: { current: null, initiator: null }, id: "parent" },
  };
  await applyRunMessagesStep({
    messages: [
      {
        context: { parent: { sessionId: "parent" } } as AgentSessionContext,
        from: {
          callId: "call-1",
          input: {},
          runId: "run-1",
          sequence: 0,
          stepIndex: 0,
          toolName: "execute",
          turnId: "turn_0",
        },
        kind: "agent-started",
        session: {
          callbackBaseUrl: "https://parent.example",
          dynamicBinding: opening,
          kind: "remote",
          name: "tenant-remote",
          nodeId: "subagents/tenant-remote",
          resolverId: "subagents/tenant-remote",
          sessionId: "child-1",
          url: "https://tenant.example",
        },
      },
    ],
    serializedContext: {},
    sessionState: createTestSessionState({ sessionId: "parent" }),
    sessionWritable: new WritableStream<Uint8Array>(),
  });

  expect(vi.mocked(recordRemoteChildBinding)).toHaveBeenCalledWith(
    "parent",
    expect.objectContaining({
      childSessionId: "child-1",
      dynamicBinding: opening,
      resolverId: "subagents/tenant-remote",
    }),
  );
});
