import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { applyReactionEffects, evaluateValues, restoreReactions } from "../runner.js";
import { forgetSessionLive } from "../state.js";
import { dynamicSkillManifest } from "./skill.js";

/** A sandbox that records the paths written to it, under its own identity. */
function sandbox(id: string) {
  const written: string[] = [];
  return {
    access: {
      captureState: async () => ({ session: { id } }),
      get: async () => ({
        removePath: async () => {},
        run: async () => ({ exitCode: 0, stderr: "", stdout: "/home/user\n" }),
        writeBinaryFile: async ({ path }: { readonly path: string }) => {
          written.push(path);
        },
      }),
      stop: async () => {},
    },
    written,
  };
}

const policySkill = (slug: string, reference: string) => ({
  logicalPath: `skills/${slug}.ts`,
  // Each returns a skill named "policy", as a map of skills does.
  render: () => ({
    policy: defineSkill({
      description: `The ${slug} policy.`,
      files: { [`references/${reference}.md`]: "Policy reference.\n" },
      markdown: "# Policy",
    }),
  }),
  select: () => null,
  slug,
  sourceId: `skills/${slug}.ts`,
});

/** A session whose one dynamic skill renders a supporting file, which its record doesn't hold. */
function session(skills?: readonly object[]) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: ctx.get(SessionIdKey),
  } as never);
  ctx.set(BundleKey, {
    resolvedAgent: {
      dynamicInstructionsResolvers: [],
      dynamicSkillResolvers: skills ?? [
        {
          logicalPath: "skills/policy.ts",
          render: () =>
            defineSkill({
              description: "The tenant policy.",
              files: { "references/policy.md": "Policy reference.\n" },
              markdown: "# Policy",
            }),
          select: () => null,
          slug: "policy",
          sourceId: "skills/policy.ts",
        },
      ],
      dynamicToolResolvers: [],
      hooks: [],
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {},
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

const PACKAGE = [
  "/home/user/.agents/skills/policy/SKILL.md",
  "/home/user/.agents/skills/policy/references/policy.md",
];

describe("dynamic skill files", () => {
  it("writes a rendered file to a sandbox created later, by a process that didn't render it", async () => {
    const ctx = session();
    const first = sandbox("first");
    ctx.set(SandboxKey, first.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
    expect(first.written).toEqual(PACKAGE);

    // The same sandbox already has the package: the next step writes nothing.
    await contextStorage.run(ctx, () => applyReactionEffects(ctx));
    expect(first.written).toEqual(PACKAGE);

    // A fresh process with a new sandbox renders the skill again from its record to write it.
    forgetSessionLive(ctx.get(SessionIdKey)!);
    const next = sandbox("next");
    ctx.set(SandboxKey, next.access as never);
    await contextStorage.run(ctx, async () => {
      await restoreReactions(ctx);
      await applyReactionEffects(ctx);
    });
    expect(next.written).toEqual(PACKAGE);
  });

  it("writes the files of the skill whose metadata the model sees when two name it", async () => {
    const ctx = session([policySkill("first", "first"), policySkill("second", "second")]);
    const box = sandbox("box");
    ctx.set(SandboxKey, box.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    const manifest = dynamicSkillManifest(ctx);
    expect(
      Object.values(manifest)
        .flat()
        .map((skill) => skill.description),
    ).toEqual(["The first policy."]);
    expect(box.written).toEqual([
      "/home/user/.agents/skills/policy/SKILL.md",
      "/home/user/.agents/skills/policy/references/first.md",
    ]);
  });
});
