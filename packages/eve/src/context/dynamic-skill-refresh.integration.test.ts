import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { DynamicSkillManifestKey, SandboxKey, SessionIdKey } from "#context/keys.js";
import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { createTurnStartedEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

async function createSession() {
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
  const skillRoot = await resolveSandboxSkillRoot({ sandbox: handle.session });
  return { ctx, sandbox: handle.session, skillRoot };
}

function resolverFor(handler: ResolvedDynamicSkillResolver["events"]["turn.started"]) {
  return {
    eventNames: ["turn.started"],
    events: { "turn.started": handler },
    exportName: "default",
    logicalPath: "skills/playbook.ts",
    slug: "playbook",
    sourceId: "skills/playbook.ts",
    sourceKind: "module",
  } satisfies ResolvedDynamicSkillResolver;
}

describe("dynamic skill package refresh", () => {
  it("removes omitted siblings while refreshing text and binary files in the same sandbox", async () => {
    const { ctx, sandbox, skillRoot } = await createSession();
    let skill: SkillPackageDefinition = defineSkill({
      description: "Team playbook",
      markdown: "Revision one",
      files: {
        "references/obsolete.txt": "Retired instructions",
        "references/current.txt": "Old instructions",
        "assets/data.bin": new Uint8Array([0, 128, 255]),
      },
    });
    const resolver = resolverFor(() => skill);
    await sandbox.writeTextFile({
      content: "Unrelated skill",
      path: `${skillRoot}/other/SKILL.md`,
    });

    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(
      sandbox.readTextFile({ path: `${skillRoot}/playbook/references/obsolete.txt` }),
    ).resolves.toBe("Retired instructions");

    skill = defineSkill({
      description: "Updated team playbook",
      markdown: "Revision two",
      files: {
        "references/current.txt": "Current instructions",
        "assets/data.bin": new Uint8Array([255, 0, 129, 10]),
      },
    });
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      messages: [],
      resolvers: [resolver],
    });

    const listing = await sandbox.run({
      command: "find . -type f",
      workingDirectory: `${skillRoot}/playbook`,
    });
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.trim().split("\n").sort()).toEqual([
      "./SKILL.md",
      "./assets/data.bin",
      "./references/current.txt",
    ]);
    await expect(sandbox.readTextFile({ path: `${skillRoot}/playbook/SKILL.md` })).resolves.toBe(
      "Revision two",
    );
    await expect(
      sandbox.readTextFile({ path: `${skillRoot}/playbook/references/current.txt` }),
    ).resolves.toBe("Current instructions");
    const bytes = await sandbox.readBinaryFile({ path: `${skillRoot}/playbook/assets/data.bin` });
    expect(bytes).toEqual(Buffer.from([255, 0, 129, 10]));
    await expect(sandbox.readTextFile({ path: `${skillRoot}/other/SKILL.md` })).resolves.toBe(
      "Unrelated skill",
    );
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      playbook: [{ description: "Updated team playbook", name: "playbook" }],
    });
  });

  it.each([
    { beforePath: "reference", afterPath: "reference/guide.txt" },
    { beforePath: "reference/guide.txt", afterPath: "reference" },
  ])("replaces $beforePath with $afterPath", async ({ beforePath, afterPath }) => {
    const { ctx, sandbox, skillRoot } = await createSession();
    let files = { [beforePath]: "Old file" };
    const resolver = resolverFor(() =>
      defineSkill({ description: "Playbook", markdown: "Instructions", files }),
    );
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [resolver],
    });
    files = { [afterPath]: "New file" };
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(
      sandbox.readTextFile({ path: `${skillRoot}/playbook/${afterPath}` }),
    ).resolves.toBe("New file");
  });

  it("propagates a write failure without publishing a successful refresh", async () => {
    const { ctx, sandbox, skillRoot } = await createSession();
    let skill = defineSkill({ description: "Original playbook", markdown: "Original" });
    const resolver = resolverFor(() => skill);
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [resolver],
    });

    skill = defineSkill({
      description: "Broken playbook",
      markdown: "Broken",
      files: { reference: "File", "reference/guide.txt": "Cannot be written below a file" },
    });
    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
        messages: [],
        resolvers: [resolver],
      }),
    ).rejects.toThrow();
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      playbook: [{ description: "Original playbook", name: "playbook" }],
    });

    skill = defineSkill({ description: "Repaired playbook", markdown: "Repaired" });
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 2, turnId: "turn_2" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(sandbox.readTextFile({ path: `${skillRoot}/playbook/SKILL.md` })).resolves.toBe(
      "Repaired",
    );
  });
});
