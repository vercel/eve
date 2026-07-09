import { describe, expect, it } from "vitest";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionKey, StaticSkillNamesKey } from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createContext() {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  ctx.set(
    SandboxKey,
    mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/child-only/SKILL.md": "# Child\n",
        "/home/agent/.agents/skills/parent-only/SKILL.md": "# Parent\n",
      },
    }).access,
  );
  ctx.set(StaticSkillNamesKey, ["parent-only"]);
  return ctx;
}

describe("buildCallbackContext", () => {
  it("allows authored code to read skills visible to the active agent", async () => {
    const ctx = createContext();

    const handle = contextStorage.run(ctx, () => buildCallbackContext().getSkill("parent-only"));

    await expect(handle.file("SKILL.md").text()).resolves.toBe("# Parent\n");
  });

  it("rejects authored skill handles hidden from the active agent", () => {
    const ctx = createContext();

    expect(() =>
      contextStorage.run(ctx, () => buildCallbackContext().getSkill("child-only")),
    ).toThrow(
      'Skill "child-only" is not available to the active agent. Available skills: parent-only.',
    );
  });
});
