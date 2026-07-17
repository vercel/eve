import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  captureAuthoredSkillBaseline,
  recoverCapturedAuthoredSkillBaseline,
} from "#context/dynamic-skill-authored-baseline.js";
import { DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE } from "#context/dynamic-skill-materialization-marker.js";
import {
  PendingSkillAnnouncementKey,
  dispatchDynamicSkillEvent,
} from "#context/dynamic-skill-lifecycle.js";
import { DynamicSkillManifestKey, SessionIdKey, SandboxKey } from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import { normalizeSkillPackage } from "#shared/skill-package.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

interface MockAuthoredSkillDefinition {
  readonly description: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly markdown: string;
}

function createMockBundle(
  authoredSkillNames: readonly string[] = [],
  authoredSkills: Readonly<Record<string, MockAuthoredSkillDefinition>> = {},
): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: authoredSkillNames.map((name) => {
        const definition = authoredSkills[name] ?? {
          description: `Authored ${name}`,
          markdown: `Authored ${name} body.`,
        };
        const normalized = normalizeSkillPackage({ ...definition, name });
        return {
          ...definition,
          contentDigest: normalized.contentDigest,
          name,
          relativePaths: normalized.files.map((file) => file.relativePath),
        };
      }),
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function createCtx(
  authoredSkillNames: readonly string[] = [],
  authoredSkills: Readonly<Record<string, MockAuthoredSkillDefinition>> = {},
) {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  ctx.set(SessionIdKey, "test-session");
  ctx.set(SandboxKey, sandbox.access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames, authoredSkills));
  return { ctx, sandbox };
}

function createCtxWithAuthoredDogReference() {
  return createCtx(["talk-like-a-dog"], {
    "talk-like-a-dog": {
      description: "Authored talk-like-a-dog",
      files: { "references/authored.md": "Authored reference" },
      markdown: "Authored talk-like-a-dog body.",
    },
  });
}

function setBaselineLessDynamicDogManifest(ctx: ContextContainer): void {
  const dynamic = normalizeSkillPackage({
    description: "Dynamic override",
    markdown: "Woof.",
    name: "talk-like-a-dog",
  });
  ctx.set(DynamicSkillManifestKey, {
    custom: [
      {
        contentDigest: dynamic.contentDigest,
        description: dynamic.description,
        name: dynamic.name,
        relativePaths: dynamic.files.map((file) => file.relativePath),
      },
    ],
  });
}

function createResolver(
  slug: string,
  handler: () =>
    | SkillPackageDefinition
    | Record<string, SkillPackageDefinition>
    | null
    | Promise<SkillPackageDefinition | Record<string, SkillPackageDefinition> | null>,
  extensionNamespace?: string,
  eventNames: readonly ("session.started" | "turn.started")[] = ["session.started"],
): ResolvedDynamicSkillResolver {
  const events = Object.fromEntries(eventNames.map((eventName) => [eventName, handler]));
  return {
    eventNames,
    events,
    exportName: "default",
    extensionNamespace,
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

function makeEvent(
  type: "session.started" | "turn.started" = "session.started",
): HandleMessageStreamEvent {
  return { type, data: {} } as HandleMessageStreamEvent;
}

function makeSkill(
  description: string,
  markdown = description,
  files?: Readonly<Record<string, string | Uint8Array>>,
  metadata?: Record<string, string>,
): SkillPackageDefinition {
  return defineSkill({
    description,
    files,
    markdown,
    metadata,
  });
}

describe("dispatchDynamicSkillEvent", () => {
  it("writes identical session- and turn-start packages once total", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, sandbox } = createCtx();
    let resolverCalls = 0;
    const resolver = createResolver(
      "tenant",
      () => {
        resolverCalls += 1;
        return makeSkill("Tenant policy", "Follow tenant policy.");
      },
      undefined,
      ["session.started", "turn.started"],
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent("session.started"),
      messages: [],
      resolvers: [resolver],
    });
    const writesAfterSessionStart = sandbox.writes.length;
    const removesAfterSessionStart = sandbox.removedPaths.length;

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [resolver],
    });

    expect(writesAfterSessionStart).toBeGreaterThan(0);
    expect(sandbox.writes).toHaveLength(writesAfterSessionStart);
    expect(sandbox.removedPaths).toHaveLength(removesAfterSessionStart);
    expect(resolverCalls).toBe(2);
    expect(log.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: "turn.started",
      removeCallCount: 0,
      unchangedPackageCount: 1,
      writeByteCount: 0,
      writeFileCount: 0,
      writePackageCount: 0,
    });
    log.mockRestore();
  });

  it("removes a sibling that disappears from a changed package", async () => {
    const { ctx, sandbox } = createCtx();
    let files: Readonly<Record<string, string>> = {
      "references/policy.md": "original policy",
    };
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", "Follow tenant policy.", files),
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(sandbox.files.has("/home/agent/.agents/skills/tenant/references/policy.md")).toBe(true);
    const removalsBeforeChange = sandbox.removedPaths.length;

    files = {};
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.has("/home/agent/.agents/skills/tenant/references/policy.md")).toBe(false);
    expect(sandbox.removedPaths.slice(removalsBeforeChange)).toEqual([
      "/home/agent/.agents/skills/.eve-dynamic-skill-materialization.json",
      "/home/agent/.agents/skills/tenant",
    ]);
  });

  it("rewrites same-metadata packages when exact body bytes change", async () => {
    const { ctx, sandbox } = createCtx();
    let markdown = "Original policy.";
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", markdown, undefined, { contentHash: "application-value" }),
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    const writesBeforeChange = sandbox.writes.length;

    markdown = "Updated policy.";
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/SKILL.md")).toBe("Updated policy.");
    expect(
      sandbox.writes
        .slice(writesBeforeChange)
        .filter((write) => write.path.endsWith("/tenant/SKILL.md")),
    ).toHaveLength(1);
  });

  it("rematerializes the current package set after the sandbox is recreated", async () => {
    const { ctx } = createCtx();
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", "Follow tenant policy."),
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    const recreated = mockSandbox({
      id: "sbx_mock",
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });
    ctx.set(SandboxKey, recreated.access);

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(recreated.files.get("/home/agent/.agents/skills/tenant/SKILL.md")).toBe(
      "Follow tenant policy.",
    );
    expect(
      recreated.files.has(
        `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`,
      ),
    ).toBe(true);
  });

  it.each([
    ["corrupt", "{"],
    ["old", JSON.stringify({ packages: {}, version: 0 })],
  ])("safely rematerializes after a %s sandbox marker", async (_label, marker) => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", "Follow tenant policy."),
    );
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    sandbox.files.set(markerPath, marker);
    sandbox.fileBytes.set(markerPath, Buffer.from(marker));
    const writesBeforeRecovery = sandbox.writes.length;

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(
      sandbox.writes
        .slice(writesBeforeRecovery)
        .filter((write) => write.path.endsWith("/tenant/SKILL.md")),
    ).toHaveLength(1);
    expect(sandbox.files.get(markerPath)).toContain('"version":1');
  });

  it("writes the sandbox marker only after every package mutation succeeds", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", "Follow tenant policy.", {
        "references/policy.md": "Policy body",
      }),
    );
    const failingSession = {
      ...sandbox.session,
      async writeBinaryFile(options: Parameters<typeof sandbox.session.writeBinaryFile>[0]) {
        if (options.path.endsWith("/references/policy.md")) {
          throw new Error("injected sibling write failure");
        }
        await sandbox.session.writeBinaryFile(options);
      },
    };
    ctx.set(SandboxKey, {
      async captureState() {
        return { initialized: false, session: null };
      },
      async get() {
        return failingSession;
      },
    });

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [resolver],
      }),
    ).rejects.toThrow("injected sibling write failure");

    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
    expect(sandbox.files.has(markerPath)).toBe(false);
    expect(ctx.get(DynamicSkillManifestKey)).toHaveProperty("tenant");

    ctx.set(SandboxKey, sandbox.access);
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/references/policy.md")).toBe(
      "Policy body",
    );
    expect(sandbox.files.has(markerPath)).toBe(true);
  });

  it("clears removed dynamic skills from the durable announcement", async () => {
    const { ctx, sandbox } = createCtx();
    let enabled = true;
    const resolver = createResolver("tenant", () =>
      enabled ? makeSkill("Tenant policy", "Follow tenant policy.") : null,
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("tenant: Tenant policy");
    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      tenant: [
        {
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          description: "Tenant policy",
          name: "tenant",
          relativePaths: ["SKILL.md"],
        },
      ],
    });
    const removalsBeforeDisable = sandbox.removedPaths.length;

    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("");
    expect(sandbox.removedPaths.slice(removalsBeforeDisable)).toEqual([
      "/home/agent/.agents/skills/.eve-dynamic-skill-materialization.json",
      "/home/agent/.agents/skills/tenant",
    ]);
  });

  it("keeps remaining dynamic skills in the announcement when one resolver removes its skill", async () => {
    const { ctx } = createCtx();
    let tenantEnabled = true;
    const tenant = createResolver("tenant", () =>
      tenantEnabled ? makeSkill("Tenant policy") : null,
    );
    const support = createResolver("support", () => makeSkill("Support policy"));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [tenant, support],
    });

    tenantEnabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [tenant, support],
    });

    const announcement = ctx.get(PendingSkillAnnouncementKey);
    expect(announcement).not.toContain("tenant: Tenant policy");
    expect(announcement).toContain("support: Support policy");
  });

  it("names map entries by their bare key", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("custom", () => ({
      "talk-like-a-dog": makeSkill("Talk like a dog", "Woof."),
    }));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      custom: [
        {
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          description: "Talk like a dog",
          name: "talk-like-a-dog",
          relativePaths: ["SKILL.md"],
        },
      ],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("talk-like-a-dog: Talk like a dog");
    expect(
      sandbox.writes.some((w) => w.path.includes("/home/agent/.agents/skills/talk-like-a-dog/")),
    ).toBe(true);
  });

  it("prefixes map entries with the mount namespace for an extension resolver", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver(
      "crm__playbooks",
      () => ({ triage: makeSkill("Triage an account", "Triage.") }),
      "crm",
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      crm__playbooks: [
        {
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          description: "Triage an account",
          name: "crm__triage",
          relativePaths: ["SKILL.md"],
        },
      ],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("crm__triage: Triage an account");
    expect(
      sandbox.writes.some((w) => w.path.includes("/home/agent/.agents/skills/crm__triage/")),
    ).toBe(true);
  });

  it("lets a dynamic skill override a same-named authored skill instead of throwing", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    let enabled = true;
    const authoredSkill = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    sandbox.files.set(authoredSkill, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(authoredSkill, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    const resolver = createResolver(
      "custom",
      (): Record<string, SkillPackageDefinition> =>
        enabled
          ? {
              "talk-like-a-dog": makeSkill("Dynamic override", "Woof."),
            }
          : {},
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    // No throw; the dynamic skill is written to the authored skill's path.
    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      custom: [
        {
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          description: "Dynamic override",
          name: "talk-like-a-dog",
          relativePaths: ["SKILL.md"],
        },
      ],
    });
    expect(
      sandbox.writes.some((w) =>
        w.path.includes("/home/agent/.agents/skills/talk-like-a-dog/SKILL.md"),
      ),
    ).toBe(true);
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");

    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
    sandbox.files.set(markerPath, "not json");
    sandbox.fileBytes.set(markerPath, Buffer.from("not json"));
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");

    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get(authoredSkill)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
  });

  it("restores the exact authored baseline when a dynamic override retires", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    const dynamicReference = "/home/agent/.agents/skills/talk-like-a-dog/references/dynamic.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    let enabled = true;
    const resolver = createResolver("custom", () =>
      enabled
        ? {
            "talk-like-a-dog": makeSkill("Dynamic override", "Woof.", {
              "references/dynamic.md": "Dynamic reference",
            }),
          }
        : null,
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
    expect(sandbox.files.has(dynamicReference)).toBe(false);
  });

  it("retains authored baseline metadata when dynamic override retirement fails", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    const dynamicReference = "/home/agent/.agents/skills/talk-like-a-dog/references/dynamic.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    let enabled = true;
    const resolver = createResolver("custom", () =>
      enabled
        ? {
            "talk-like-a-dog": makeSkill("Dynamic override", "Woof.", {
              "references/dynamic.md": "Dynamic reference",
            }),
          }
        : null,
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    enabled = false;
    const failingSession = {
      ...sandbox.session,
      async writeBinaryFile(options: Parameters<typeof sandbox.session.writeBinaryFile>[0]) {
        if (options.path === authoredReference)
          throw new Error("injected baseline restore failure");
        await sandbox.session.writeBinaryFile(options);
      },
    };
    ctx.set(SandboxKey, {
      async captureState() {
        return { initialized: false, session: null };
      },
      async get() {
        return failingSession;
      },
    });

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [resolver],
      }),
    ).rejects.toThrow("injected baseline restore failure");
    expect(ctx.get(DynamicSkillManifestKey)?.custom?.[0]?.authoredBaseline).toHaveLength(2);

    ctx.set(SandboxKey, sandbox.access);
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
    expect(sandbox.files.has(dynamicReference)).toBe(false);
  });

  it("preserves a newly authored package when stale dynamic ownership retires on an unmatched event", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    setBaselineLessDynamicDogManifest(ctx);
    const resolver = createResolver("custom", () => null, undefined, ["session.started"]);

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(sandbox.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
  });

  it("preserves a newly authored package when its stale dynamic resolver is removed", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    setBaselineLessDynamicDogManifest(ctx);

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(sandbox.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
  });

  it("replaces a non-file marker while preserving a newly authored package", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
    const markerChild = `${markerPath}/injected`;
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    sandbox.files.set(markerChild, "Injected node.");
    sandbox.fileBytes.set(markerChild, Buffer.from("Injected node."));
    setBaselineLessDynamicDogManifest(ctx);
    const directoryMarkerSession = {
      ...sandbox.session,
      async readTextFile(options: Parameters<typeof sandbox.session.readTextFile>[0]) {
        if (options.path === markerPath) throw new Error("EISDIR: marker is a directory");
        return await sandbox.session.readTextFile(options);
      },
      async writeTextFile(options: Parameters<typeof sandbox.session.writeTextFile>[0]) {
        if (options.path === markerPath && sandbox.files.has(markerChild)) {
          throw new Error("EISDIR: marker is still a directory");
        }
        await sandbox.session.writeTextFile(options);
      },
    };
    ctx.set(SandboxKey, {
      async captureState() {
        return { initialized: false, session: null };
      },
      async get() {
        return directoryMarkerSession;
      },
    });

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(sandbox.files.has(markerChild)).toBe(false);
    expect(sandbox.files.get(markerPath)).toContain('"packages":{}');
    expect(sandbox.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
  });

  it("rebuilds a changed dynamic override over the exact authored baseline", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    const staleReference = "/home/agent/.agents/skills/talk-like-a-dog/references/stale.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    let changed = false;
    const resolver = createResolver("custom", () =>
      changed
        ? { "talk-like-a-dog": makeSkill("Dynamic override", "New woof.") }
        : {
            "talk-like-a-dog": makeSkill("Dynamic override", "Old woof.", {
              "references/stale.md": "Stale",
            }),
          },
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(ctx.get(DynamicSkillManifestKey)?.custom?.[0]?.authoredBaseline).toHaveLength(2);
    changed = true;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(sandbox.files.get(skillPath)).toBe("New woof.");
    expect(sandbox.files.get(authoredReference)).toBe("Authored reference");
    expect(sandbox.files.has(staleReference)).toBe(false);
  });

  it("recaptures the authored baseline after sandbox replacement", async () => {
    const { ctx, sandbox } = createCtxWithAuthoredDogReference();
    const authoredReference = "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md";
    sandbox.files.set(
      "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md",
      "Authored talk-like-a-dog body.",
    );
    sandbox.fileBytes.set(
      "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md",
      Buffer.from("Authored talk-like-a-dog body."),
    );
    sandbox.files.set(authoredReference, "Authored reference");
    sandbox.fileBytes.set(authoredReference, Buffer.from("Authored reference"));
    const resolver = createResolver("custom", () => ({
      "talk-like-a-dog": makeSkill("Dynamic override", "Woof."),
    }));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    const recreated = mockSandbox({
      id: "sbx_recreated",
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md": "Authored talk-like-a-dog body.",
        "/home/agent/.agents/skills/talk-like-a-dog/references/authored.md": "Authored reference",
      },
    });
    ctx.set(SandboxKey, recreated.access);

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(recreated.files.get("/home/agent/.agents/skills/talk-like-a-dog/SKILL.md")).toBe(
      "Woof.",
    );
    expect(
      recreated.files.get("/home/agent/.agents/skills/talk-like-a-dog/references/authored.md"),
    ).toBe("Authored reference");
  });

  it("reuses the captured authored baseline when sandbox replacement retries before serialization", async () => {
    const { ctx, sandbox } = createCtx(["talk-like-a-dog"]);
    const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
    sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
    sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
    let enabled = true;
    const resolver = createResolver("custom", () =>
      enabled ? { "talk-like-a-dog": makeSkill("Dynamic override", "Woof.") } : null,
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    const durableSandboxAManifest = structuredClone(ctx.get(DynamicSkillManifestKey)!);

    const recreated = mockSandbox({
      id: "sbx_recreated_retry",
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        [skillPath]: "Authored talk-like-a-dog body.",
      },
    });
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
    const failingSession = {
      ...recreated.session,
      async writeTextFile(options: Parameters<typeof recreated.session.writeTextFile>[0]) {
        if (options.path === markerPath) throw new Error("injected post-overlay failure");
        await recreated.session.writeTextFile(options);
      },
    };
    ctx.set(SandboxKey, {
      async captureState() {
        return { initialized: false, session: null };
      },
      async get() {
        return failingSession;
      },
    });

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [resolver],
      }),
    ).rejects.toThrow("injected post-overlay failure");
    expect(recreated.files.get(skillPath)).toBe("Woof.");

    // The workflow failed before serializing the sandbox-B manifest, so the
    // retry reconstructs the durable context from sandbox A.
    ctx.set(DynamicSkillManifestKey, durableSandboxAManifest);
    ctx.set(SandboxKey, recreated.access);
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(recreated.files.get(skillPath)).toBe("Authored talk-like-a-dog body.");
  });

  it.each(["deleted", "forged"] as const)(
    "rejects a %s same-generation authored baseline after a post-overlay retry",
    async (state) => {
      const { ctx, sandbox } = createCtx(["talk-like-a-dog"]);
      const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
      sandbox.files.set(skillPath, "Authored talk-like-a-dog body.");
      sandbox.fileBytes.set(skillPath, Buffer.from("Authored talk-like-a-dog body."));
      const resolver = createResolver("custom", () => ({
        "talk-like-a-dog": makeSkill("Dynamic override", "Woof."),
      }));

      await dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [resolver],
      });
      const durableSandboxAManifest = structuredClone(ctx.get(DynamicSkillManifestKey)!);

      const recreated = mockSandbox({
        id: "sbx_recreated_corrupt",
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
        initialFiles: {
          [skillPath]: "Authored talk-like-a-dog body.",
        },
      });
      const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
      const failingSession = {
        ...recreated.session,
        async writeTextFile(options: Parameters<typeof recreated.session.writeTextFile>[0]) {
          if (options.path === markerPath) throw new Error("injected post-overlay failure");
          await recreated.session.writeTextFile(options);
        },
      };
      ctx.set(SandboxKey, {
        async captureState() {
          return { initialized: false, session: null };
        },
        async get() {
          return failingSession;
        },
      });

      await expect(
        dispatchDynamicSkillEvent({
          ctx,
          event: makeEvent(),
          messages: [],
          resolvers: [resolver],
        }),
      ).rejects.toThrow("injected post-overlay failure");

      const baselineRoot =
        "/home/agent/.agents/skills/.eve-dynamic-skill-authored-baselines/talk-like-a-dog";
      const baselineSkillPath = `${baselineRoot}/SKILL.md`;
      const receiptPath = `${baselineRoot}.receipt.json`;
      if (state === "deleted") {
        recreated.files.delete(baselineSkillPath);
        recreated.fileBytes.delete(baselineSkillPath);
        recreated.files.delete(receiptPath);
        recreated.fileBytes.delete(receiptPath);
      } else {
        const forgedBody = Buffer.from("Woof.");
        const forgedReceipt = `${JSON.stringify({
          baseline: [
            {
              contentDigest: createHash("sha256").update(forgedBody).digest("hex"),
              relativePath: "SKILL.md",
            },
          ],
          sandboxId: "sbx_recreated_corrupt",
          version: 1,
        })}\n`;
        recreated.files.set(baselineSkillPath, "Woof.");
        recreated.fileBytes.set(baselineSkillPath, forgedBody);
        recreated.files.set(receiptPath, forgedReceipt);
        recreated.fileBytes.set(receiptPath, Buffer.from(forgedReceipt));
      }

      ctx.set(DynamicSkillManifestKey, durableSandboxAManifest);
      ctx.set(SandboxKey, recreated.access);
      await expect(
        dispatchDynamicSkillEvent({
          ctx,
          event: makeEvent(),
          messages: [],
          resolvers: [resolver],
        }),
      ).rejects.toThrow(/authored skill baseline/iu);
    },
  );

  it.each(["deleted", "tampered"] as const)(
    "fails closed when the same-generation baseline receipt is %s",
    async (state) => {
      const { sandbox } = createCtx(["talk-like-a-dog"], {
        "talk-like-a-dog": {
          description: "Authored talk-like-a-dog",
          markdown: "Authored body.",
        },
      });
      const skillPath = "/home/agent/.agents/skills/talk-like-a-dog/SKILL.md";
      const receiptPath =
        "/home/agent/.agents/skills/.eve-dynamic-skill-authored-baselines/talk-like-a-dog.receipt.json";
      sandbox.files.set(skillPath, "Authored body.");
      sandbox.fileBytes.set(skillPath, Buffer.from("Authored body."));
      const normalized = normalizeSkillPackage({
        description: "Authored talk-like-a-dog",
        markdown: "Authored body.",
        name: "talk-like-a-dog",
      });
      const identity = {
        contentDigest: normalized.contentDigest,
        description: normalized.description,
        name: normalized.name,
        relativePaths: normalized.files.map((file) => file.relativePath),
      };
      await captureAuthoredSkillBaseline({
        identity,
        name: "talk-like-a-dog",
        sandbox: sandbox.session,
      });
      sandbox.files.set(skillPath, "Dynamic body.");
      sandbox.fileBytes.set(skillPath, Buffer.from("Dynamic body."));

      if (state === "deleted") {
        sandbox.files.delete(receiptPath);
        sandbox.fileBytes.delete(receiptPath);
      } else {
        sandbox.files.set(receiptPath, "not json");
        sandbox.fileBytes.set(receiptPath, Buffer.from("not json"));
      }

      await expect(
        recoverCapturedAuthoredSkillBaseline({
          identity,
          name: "talk-like-a-dog",
          sandbox: sandbox.session,
        }),
      ).rejects.toThrow(`Authored skill baseline receipt for "talk-like-a-dog" is`);
      expect(sandbox.files.get(skillPath)).toBe("Dynamic body.");
    },
  );

  it("collapses a directly-returned single defineSkill to the bare slug", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("tenant", () => makeSkill("Tenant policy"));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toMatchObject({
      tenant: [
        {
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          description: "Tenant policy",
          name: "tenant",
          relativePaths: ["SKILL.md"],
        },
      ],
    });
    expect(sandbox.writes.some((w) => w.path.includes("/home/agent/.agents/skills/tenant/"))).toBe(
      true,
    );
  });

  it("throws and recommends manual namespacing when two resolvers emit the same name", async () => {
    const { ctx, sandbox } = createCtx();
    const alpha = createResolver("alpha", () => ({ shared: makeSkill("From alpha") }));
    const beta = createResolver("beta", () => ({ shared: makeSkill("From beta") }));

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [alpha, beta],
      }),
    ).rejects.toThrow(/Dynamic skill "shared".*Namespace the map key manually/u);

    expect(sandbox.writes).toEqual([]);
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
    expect(ctx.get(PendingSkillAnnouncementKey)).toBeUndefined();
  });
});
