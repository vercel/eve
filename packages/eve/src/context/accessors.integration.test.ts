import { describe, expect, it } from "vitest";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { RuntimeSandboxSession, SandboxSession } from "#public/definitions/sandbox.js";
import { VercelSandbox } from "#public/sandbox/vercel.js";

/**
 * Integration coverage for {@link buildCallbackContext} — the single
 * factory that builds the `ctx` object every authored callback receives.
 *
 * Each case runs in-memory through the AppHarness.
 * `runtime.runAsSession(init, fn)` binds the authored context and
 * invokes `fn`.
 */

describe("buildCallbackContext – session", () => {
  it("throws when no authored runtime session is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("returns the active session identity across async boundaries", async () => {
    const runtime = await createTestRuntime();

    const session = await runtime.runAsSession(
      {
        sessionId: "session_public_session",
        turn: { id: "turn_public_session_001", sequence: 1 },
      },
      async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return buildCallbackContext().session;
      },
    );

    expect(session).toEqual({
      context: {},
      auth: {
        current: null,
        initiator: null,
      },
      id: "session_public_session",
      turn: {
        id: "turn_public_session_001",
        sequence: 1,
      },
    });
  });

  it("preserves parent lineage on the public session", async () => {
    const runtime = await createTestRuntime();

    const session = await runtime.runAsSession(
      {
        parent: {
          callId: "call_parent_001",
          rootSessionId: "session_parent",
          sessionId: "session_parent",
          turn: { id: "turn_parent_001", sequence: 3 },
        },
        sessionId: "session_public_child",
        turn: { id: "turn_public_child_001", sequence: 1 },
      },
      () => buildCallbackContext().session,
    );

    expect(session.parent).toEqual({
      callId: "call_parent_001",
      rootSessionId: "session_parent",
      sessionId: "session_parent",
      turn: { id: "turn_parent_001", sequence: 3 },
    });
  });
});

describe("buildCallbackContext – getSandbox", () => {
  it("throws when no authored runtime context is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("returns the active authored sandbox across async boundaries", async () => {
    const sandboxId = "sbx_public_sandbox";
    const sandbox = mockSandbox({
      id: sandboxId,
      commands: {
        "echo ready": { exitCode: 0, stderr: "", stdout: "ready" },
      },
    });
    const runtime = await createTestRuntime();

    const live = (await runtime.runAsSession({ sandbox }, async () => {
      await Promise.resolve();
      return await buildCallbackContext().getSandbox();
    })) as SandboxSession;

    await live.run({ command: "echo ready" });

    expect(sandbox.commandLog).toEqual(["echo ready"]);
  });

  it("accepts the configured sandbox environment", async () => {
    const environment = VercelSandbox.environment();
    const sandbox = mockSandbox();
    const runtime = await createTestRuntime();

    const live = await runtime.runAsSession(
      { sandboxAccess: { ...sandbox.access, environment } },
      async () => await buildCallbackContext().getSandbox(environment),
    );

    expect(live).toBeDefined();
  });

  it("rejects a sandbox environment that is not active for the session", async () => {
    const environment = VercelSandbox.environment();
    const otherEnvironment = VercelSandbox.environment();
    const sandbox = mockSandbox();
    const runtime = await createTestRuntime();

    await expect(
      runtime.runAsSession(
        { sandboxAccess: { ...sandbox.access, environment } },
        async () => await buildCallbackContext().getSandbox(otherEnvironment),
      ),
    ).rejects.toThrow("The requested sandbox environment is not active for the current session.");
  });

  it("passes file operations through the expanded session surface", async () => {
    const sandbox = mockSandbox({
      id: "sbx_public_sandbox_file",
      initialFiles: { "note.txt": "file content" },
    });
    const runtime = await createTestRuntime();

    const live = (await runtime.runAsSession(
      { sandbox },
      async () => await buildCallbackContext().getSandbox(),
    )) as SandboxSession;

    const content = await live.readTextFile({ path: "note.txt" });
    await live.writeTextFile({ content: "updated", path: "note.txt" });
    await live.removePath({ force: true, path: "note.txt" });

    expect(content).toBe("file content");
    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.removedPaths).toEqual(["/workspace/note.txt"]);
    expect(sandbox.files.has("/workspace/note.txt")).toBe(false);
  });

  it("stops the active sandbox through the runtime session", async () => {
    let stops = 0;
    const sandbox = mockSandbox({
      stop: () => {
        stops += 1;
      },
    });
    const runtime = await createTestRuntime();

    await runtime.runAsSession({ sandbox }, async () => {
      const live: RuntimeSandboxSession = await buildCallbackContext().getSandbox();
      await live.stop();
    });

    expect(stops).toBe(1);
  });

  it("deletes the active sandbox through the runtime session", async () => {
    let deletions = 0;
    const sandbox = mockSandbox({
      delete: () => {
        deletions += 1;
      },
    });
    const runtime = await createTestRuntime();

    await runtime.runAsSession({ sandbox }, async () => {
      const live: RuntimeSandboxSession = await buildCallbackContext().getSandbox();
      await live.delete();
    });

    expect(deletions).toBe(1);
  });
});
