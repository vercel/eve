import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  dispatchDynamicSkillEvent,
  PendingSkillAnnouncementKey,
} from "#context/dynamic-skill-lifecycle.js";
import { DynamicSkillManifestKey, SandboxKey, SessionIdKey } from "#context/keys.js";
import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import { BoundaryHookError } from "#shared/boundary-hook-error.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

async function createSession() {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dynamic-skill-errors-"));
  onTestFinished(async () => await rm(appRoot, { recursive: true, force: true }));
  const handle = await createJustBashSandboxBackend({
    createOptions: { autoInstall: false },
  }).create({
    runtimeContext: { appRoot },
    sessionKey: "skill-errors",
    templateKey: null,
  });
  onTestFinished(async () => await handle.shutdown());
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "skill-errors");
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
  return { ctx, sandbox: handle.session, skillRoot, sourcePath: join(appRoot, "playbook.md") };
}

function createResolver(
  slug: string,
  handler: ResolvedDynamicSkillResolver["events"]["turn.started"],
) {
  return {
    eventNames: ["session.started", "turn.started"],
    events: { "session.started": handler, "turn.started": handler },
    exportName: "default",
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  } satisfies ResolvedDynamicSkillResolver;
}

describe("dynamic skill resolver errors", () => {
  it("rejects a failed turn refresh and permits a later refresh in the same session", async () => {
    const { ctx, sandbox, skillRoot, sourcePath } = await createSession();
    await writeFile(sourcePath, "Original playbook");
    const resolver = createResolver("playbook", async () =>
      defineSkill({ description: "Playbook", markdown: await readFile(sourcePath, "utf8") }),
    );
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(sandbox.readTextFile({ path: `${skillRoot}/playbook/SKILL.md` })).resolves.toBe(
      "Original playbook",
    );

    await rm(sourcePath);
    ctx.clearVirtualContext();
    const failedRefresh = dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(failedRefresh).rejects.toBeInstanceOf(BoundaryHookError);
    await expect(failedRefresh).rejects.toMatchObject({ cause: { code: "ENOENT" } });
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      playbook: [{ description: "Playbook", name: "playbook" }],
    });

    await writeFile(sourcePath, "Repaired playbook");
    ctx.clearVirtualContext();
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 2, turnId: "turn_2" }),
      messages: [],
      resolvers: [resolver],
    });
    await expect(sandbox.readTextFile({ path: `${skillRoot}/playbook/SKILL.md` })).resolves.toBe(
      "Repaired playbook",
    );
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("playbook: Playbook");
  });

  it("propagates session-start resolver failures", async () => {
    const { ctx, sourcePath } = await createSession();
    const resolver = createResolver("playbook", async () =>
      defineSkill({ description: "Playbook", markdown: await readFile(sourcePath, "utf8") }),
    );
    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: createSessionStartedEvent(),
        messages: [],
        resolvers: [resolver],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
  });

  it("does not apply another resolver's update when one resolver fails", async () => {
    const { ctx, sandbox, skillRoot, sourcePath } = await createSession();
    await writeFile(sourcePath, "Playbook instructions");
    const playbook = createResolver("playbook", async () =>
      defineSkill({ description: "Playbook", markdown: await readFile(sourcePath, "utf8") }),
    );
    let supportSkill = defineSkill({ description: "Original support", markdown: "Original" });
    const support = createResolver("support", () => supportSkill);
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      resolvers: [support, playbook],
    });

    await rm(sourcePath);
    supportSkill = defineSkill({ description: "Updated support", markdown: "Updated" });
    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
        messages: [],
        resolvers: [support, playbook],
      }),
    ).rejects.toMatchObject({ name: "BoundaryHookError" });
    await expect(sandbox.readTextFile({ path: `${skillRoot}/support/SKILL.md` })).resolves.toBe(
      "Original",
    );
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      playbook: [{ description: "Playbook", name: "playbook" }],
      support: [{ description: "Original support", name: "support" }],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("support: Original support");
    expect(ctx.get(PendingSkillAnnouncementKey)).not.toContain("Updated support");
  });
});
