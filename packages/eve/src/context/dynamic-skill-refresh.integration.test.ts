import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { SandboxKey, SessionIdKey } from "#context/keys.js";
import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { createTurnStartedEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

describe("dynamic skill package refresh", () => {
  it("replaces the previous package contents without changing unrelated packages", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dynamic-skill-refresh-"));
    onTestFinished(async () => await rm(appRoot, { recursive: true, force: true }));
    const handle = await createJustBashSandboxBackend({
      createOptions: { autoInstall: false },
    }).create({
      runtimeContext: { appRoot },
      sessionKey: "skill-refresh",
      templateKey: null,
    });
    onTestFinished(async () => await handle.shutdown());

    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "skill-refresh");
    ctx.set(SandboxKey, {
      async captureState() {
        return { initialized: true, session: await handle.captureState() };
      },
      async get() {
        return handle.session;
      },
      async stop() {
        await handle.stop();
      },
    });

    let skill: SkillPackageDefinition = defineSkill({
      description: "Team playbook",
      markdown: "Revision one",
      files: {
        "references/current.txt": "Old instructions",
        "references/obsolete.txt": "Retired instructions",
      },
    });
    const resolver = {
      eventNames: ["turn.started"],
      events: { "turn.started": () => skill },
      exportName: "default",
      logicalPath: "skills/playbook.ts",
      slug: "playbook",
      sourceId: "skills/playbook.ts",
      sourceKind: "module",
    } satisfies ResolvedDynamicSkillResolver;
    const skillRoot = await resolveSandboxSkillRoot({ sandbox: handle.session });
    await handle.session.writeTextFile({
      content: "Unrelated skill",
      path: `${skillRoot}/other/SKILL.md`,
    });

    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [resolver],
    });

    skill = defineSkill({
      description: "Updated team playbook",
      markdown: "Revision two",
      files: { "references/current.txt": "Current instructions" },
    });
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      messages: [],
      resolvers: [resolver],
    });

    const listing = await handle.session.run({
      command: "find . -type f",
      workingDirectory: `${skillRoot}/playbook`,
    });
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.trim().split("\n").sort()).toEqual([
      "./SKILL.md",
      "./references/current.txt",
    ]);
    await expect(
      handle.session.readTextFile({ path: `${skillRoot}/other/SKILL.md` }),
    ).resolves.toBe("Unrelated skill");
  });
});
