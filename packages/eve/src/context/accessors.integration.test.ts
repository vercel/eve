import { describe, expect, it } from "vitest";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { mockSkill } from "#internal/testing/mocks/mock-skill.js";
import type { SandboxSession } from "#public/definitions/sandbox.js";

/**
 * Integration coverage for {@link buildCallbackContext} — the single
 * factory that builds the `ctx` object every authored callback receives.
 *
 * Each case runs in-memory through the AppHarness.
 * `runtime.runAsSession(init, fn)` binds the authored context and
 * invokes `fn`. `mockSkill()` owns its own tmpdir cleanup via an
 * internally-registered `afterEach`.
 */

describe("buildCallbackContext – session", () => {
  it("throws when no authored runtime session is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("returns the active session identity across async boundaries", async () => {
    const runtime = createTestRuntime();

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
    const runtime = createTestRuntime();

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
    const runtime = createTestRuntime();

    const live = (await runtime.runAsSession({ sandbox }, async () => {
      await Promise.resolve();
      return await buildCallbackContext().getSandbox();
    })) as SandboxSession;

    await live.run({ command: "echo ready" });

    expect(sandbox.commandLog).toEqual(["echo ready"]);
    expect(live.id).toBe(sandboxId);
  });

  it("passes file operations through the expanded session surface", async () => {
    const sandbox = mockSandbox({
      id: "sbx_public_sandbox_file",
      initialFiles: { "note.txt": "file content" },
    });
    const runtime = createTestRuntime();

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
});

describe("buildCallbackContext – getSkill", () => {
  it("throws when no authored runtime context is active", () => {
    expect(() => buildCallbackContext()).toThrow("No active eve context");
  });

  it("throws when authored runtime execution does not include skill access", async () => {
    const runtime = createTestRuntime();

    await expect(
      runtime.runAsSession({}, () => buildCallbackContext().getSkill("semantic-model")),
    ).rejects.toThrow("eve sandbox runtime access is unavailable in the current async context.");
  });

  it("resolves visible skill files across async boundaries", async () => {
    const skill = await mockSkill({
      name: "semantic-model",
      description: "Inspect the semantic model.",
      markdown: "Inspect the semantic model.",
      references: { "catalog.yml": "entities: []\n" },
    });

    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/semantic-model/SKILL.md": "Inspect the semantic model.",
        "/workspace/skills/semantic-model/references/catalog.yml": "entities: []\n",
      },
    });
    const runtime = createTestRuntime({ skills: [skill.source] });

    const result = await runtime.runAsSession({ sandbox }, async () => {
      await Promise.resolve();
      const ctx = buildCallbackContext();

      return {
        skill: ctx.getSkill("semantic-model"),
        text: await ctx.getSkill("semantic-model").file("references/catalog.yml").text(),
      };
    });

    expect(result.skill.name).toBe("semantic-model");
    await expect(result.skill.file("SKILL.md").text()).resolves.toBe("Inspect the semantic model.");
    await expect(result.skill.file("references/catalog.yml").text()).resolves.toBe(
      "entities: []\n",
    );
    expect(result.text).toBe("entities: []\n");
  });
});
