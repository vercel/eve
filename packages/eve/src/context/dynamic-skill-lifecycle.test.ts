import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  getPendingDynamicSkillAnnouncement,
  markDynamicSkillAnnouncementPersisted,
  requeueDynamicSkillAnnouncement,
  dispatchDynamicSkillEvent,
} from "#context/dynamic-skill-lifecycle.js";
import { DynamicSkillManifestKey, SessionIdKey, SandboxKey } from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
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
): ResolvedDynamicSkillResolver {
  return {
    eventNames: ["session.started"],
    events: {
      "session.started": handler,
    },
    exportName: "default",
    extensionNamespace,
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

function makeEvent(): UnstampedMessageStreamEvent {
  return { type: "session.started", data: {} } as UnstampedMessageStreamEvent;
}

function makeSkill(description: string, markdown = description): SkillPackageDefinition {
  return defineSkill({
    description,
    markdown,
  });
}

describe("dispatchDynamicSkillEvent", () => {
  it("reconstructs an untracked manifest once", async () => {
    const { ctx } = createCtx();
    ctx.set(DynamicSkillManifestKey, {
      tenant: [{ description: "Tenant policy", name: "tenant" }],
    });
    const event = { type: "step.started", data: {} } as UnstampedMessageStreamEvent;

    await dispatchDynamicSkillEvent({ ctx, event, messages: [], resolvers: [] });
    const announcement = getPendingDynamicSkillAnnouncement(ctx);
    expect(announcement).toContain("tenant: Tenant policy");
    if (announcement === undefined) throw new TypeError("Expected a pending announcement.");
    markDynamicSkillAnnouncementPersisted(ctx, announcement);

    await dispatchDynamicSkillEvent({ ctx, event, messages: [], resolvers: [] });
    expect(getPendingDynamicSkillAnnouncement(ctx)).toBeUndefined();
  });

  it("queues an announcement only when the visible skill manifest changes", async () => {
    const { ctx } = createCtx();
    const resolver = createResolver("tenant", () => makeSkill("Tenant policy"));

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    const announcement = getPendingDynamicSkillAnnouncement(ctx);
    expect(announcement).toBeDefined();
    if (announcement === undefined) throw new TypeError("Expected a pending announcement.");
    markDynamicSkillAnnouncementPersisted(ctx, announcement);

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(getPendingDynamicSkillAnnouncement(ctx)).toBeUndefined();

    requeueDynamicSkillAnnouncement(ctx);
    expect(getPendingDynamicSkillAnnouncement(ctx)).toBe(announcement);
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

    expect(getPendingDynamicSkillAnnouncement(ctx)).toContain("tenant: Tenant policy");
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      tenant: [{ description: "Tenant policy", name: "tenant" }],
    });

    enabled = false;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(getPendingDynamicSkillAnnouncement(ctx)).toBeUndefined();
    expect(sandbox.removedPaths).toEqual(["/home/agent/.agents/skills/tenant"]);

    enabled = true;
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(getPendingDynamicSkillAnnouncement(ctx)).toContain("tenant: Tenant policy");
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

    const announcement = getPendingDynamicSkillAnnouncement(ctx);
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

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      custom: [{ description: "Talk like a dog", name: "talk-like-a-dog" }],
    });
    expect(getPendingDynamicSkillAnnouncement(ctx)).toContain("talk-like-a-dog: Talk like a dog");
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

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      crm__playbooks: [{ description: "Triage an account", name: "crm__triage" }],
    });
    expect(getPendingDynamicSkillAnnouncement(ctx)).toContain("crm__triage: Triage an account");
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
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      custom: [{ description: "Dynamic override", name: "talk-like-a-dog" }],
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

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      tenant: [{ description: "Tenant policy", name: "tenant" }],
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
    expect(getPendingDynamicSkillAnnouncement(ctx)).toBeUndefined();
  });
});
