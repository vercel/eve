import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
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

function createMockBundle(): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: [],
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function createCtx() {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox();
  ctx.set(SessionIdKey, "test-session");
  ctx.set(SandboxKey, sandbox.access);
  ctx.set(BundleKey, createMockBundle());
  return { ctx, sandbox };
}

function createResolver(
  slug: string,
  handler: () =>
    | SkillPackageDefinition
    | Record<string, SkillPackageDefinition>
    | null
    | Promise<SkillPackageDefinition | Record<string, SkillPackageDefinition> | null>,
): ResolvedDynamicSkillResolver {
  return {
    eventNames: ["session.started"],
    events: {
      "session.started": handler,
    },
    exportName: "default",
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

function makeEvent(): HandleMessageStreamEvent {
  return { type: "session.started", data: {} } as HandleMessageStreamEvent;
}

function makeSkill(description: string, markdown = description): SkillPackageDefinition {
  return defineSkill({
    description,
    markdown,
  });
}

describe("dispatchDynamicSkillEvent", () => {
  it("clears removed dynamic skills from the durable announcement", async () => {
    const { ctx } = createCtx();
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
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("");
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

  it("rejects duplicate names produced by dynamic skill resolvers before writing", async () => {
    const { ctx, sandbox } = createCtx();
    const single = createResolver("foo__bar", () => makeSkill("Single"));
    const mapped = createResolver("foo", () => ({
      bar: makeSkill("Mapped"),
      baz: makeSkill("Other mapped"),
    }));

    await expect(
      dispatchDynamicSkillEvent({
        ctx,
        event: makeEvent(),
        messages: [],
        resolvers: [single, mapped],
      }),
    ).rejects.toThrow('Dynamic skill "foo__bar"');

    expect(sandbox.writes).toEqual([]);
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
    expect(ctx.get(PendingSkillAnnouncementKey)).toBeUndefined();
  });
});
