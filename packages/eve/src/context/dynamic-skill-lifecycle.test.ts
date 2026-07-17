import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
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

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createMockBundle(authoredSkillNames: readonly string[] = []): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: authoredSkillNames.map((name) => ({ name })),
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function createCtx(authoredSkillNames: readonly string[] = []) {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  ctx.set(SessionIdKey, "test-session");
  ctx.set(SandboxKey, sandbox.access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames));
  return { ctx, sandbox };
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
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();

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
    const { ctx, sandbox } = createCtx(["talk-like-a-dog"]);
    const resolver = createResolver("custom", () => ({
      "talk-like-a-dog": makeSkill("Dynamic override", "Woof."),
    }));

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
  });

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
