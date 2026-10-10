import { expect, it, vi } from "vitest";

import { sandboxProvider } from "#context/providers/sandbox.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { readTurnState } from "#harness/session-machine/state.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

it("keeps what the sandbox provider commits when a session step saves a transition", async () => {
  const runtime = await createTestRuntime({ agent: { name: "commit-session-step" } });
  const sessionWritable = new WritableStream<Uint8Array>();
  const captured = { session: null, snapshot: "captured-in-scope" };
  const commit = vi
    .spyOn(sandboxProvider, "commit")
    .mockImplementation(async (_access, session) => ({ ...session, sandboxState: captured }));
  try {
    const published = await runtime.run(() =>
      commitSessionStep(
        { serializedContext, sessionState: createTestSessionState(), sessionWritable },
        (view) => [{ events: [], turn: { ...view.turn, grants: ["deploy"] } }],
        { origin: "relayed" },
      ),
    );
    expect(commit).toHaveBeenCalled();
    expect(published.sessionState.snapshot.session.sandboxState).toEqual(captured);
    expect(readTurnState(readDurableSession(published.sessionState).state).grants).toEqual([
      "deploy",
    ]);
  } finally {
    commit.mockRestore();
  }
});
