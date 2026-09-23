import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  PendingSkillAnnouncementKey,
  dispatchDynamicSkillEvent,
} from "#context/dynamic-skill-lifecycle.js";
import {
  StaticModelReferenceKey,
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  SessionIdKey,
  SandboxKey,
} from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SandboxSessionState } from "#sandbox/state.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const SKILL_ROOT = "/home/agent/.agents/skills";

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

function persistedSandbox(id: string): SandboxSessionState {
  return { providerName: "mock", state: { id }, stateProtocolVersion: 1 };
}

/** Mirrors ensureSandboxAccess: the persisted state appears once the sandbox starts. */
function createCtx(authoredSkillNames: readonly string[] = []) {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  const state: { session: SandboxSessionState | null; next: string } = {
    next: "sandbox-1",
    session: null,
  };
  const get = vi.fn(async () => {
    state.session ??= persistedSandbox(state.next);
    return sandbox.session;
  });
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "test-session");
  const access = {
    captureState: async () => ({ session: state.session }),
    get,
    stop: async () => {},
  };
  ctx.setVirtualContext(SandboxKey, access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames));
  return { access, ctx, get, sandbox, state };
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

function makeSkill(
  description: string,
  markdown = description,
  files?: Record<string, string>,
): SkillPackageDefinition {
  return defineSkill({ description, files, markdown });
}

async function dispatch(ctx: ContextContainer, ...resolvers: ResolvedDynamicSkillResolver[]) {
  await dispatchDynamicSkillEvent({ ctx, event: makeEvent(), messages: [], resolvers });
}

function writtenPaths(sandbox: ReturnType<typeof mockSandbox>): string[] {
  return sandbox.writes.map((write) => write.path);
}

describe("dispatchDynamicSkillEvent", () => {
  it.each(["subagent.called", "subagent.completed", "turn.completed"] as const)(
    "does not access the sandbox to rebuild announcements on %s",
    async (type) => {
      const ctx = new ContextContainer();
      const manifest = {
        policy: [{ name: "policy", description: "Tenant policy", markdown: "Tenant policy" }],
      };
      ctx.set(DynamicSkillManifestKey, manifest);

      await dispatchDynamicSkillEvent({
        ctx,
        event: { type, data: {} } as UnstampedMessageStreamEvent,
        messages: [],
        resolvers: [],
      });

      expect(ctx.get(DynamicSkillManifestKey)).toEqual(manifest);
      expect(ctx.has(PendingSkillAnnouncementKey)).toBe(false);
    },
  );

  it("restores the skill announcement at the next model step without resolving skills again", async () => {
    const { access, ctx } = createCtx();
    const handler = vi.fn(() => makeSkill("Tenant policy"));
    const resolver = createResolver("policy", handler);
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    const announcement = ctx.get(PendingSkillAnnouncementKey);
    expect(announcement).toContain("policy: Tenant policy");
    ctx.clearVirtualContext();
    ctx.setVirtualContext(SandboxKey, access);

    await dispatchDynamicSkillEvent({
      ctx,
      event: { type: "step.started", data: {} } as UnstampedMessageStreamEvent,
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(PendingSkillAnnouncementKey)).toBe(announcement);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("announces when all dynamic skills are withdrawn without opening the sandbox", async () => {
    const { ctx, get } = createCtx();
    let enabled = true;
    const resolver = createResolver("tenant", () =>
      enabled ? makeSkill("Tenant policy", "Follow tenant policy.") : null,
    );

    await dispatch(ctx, resolver);

    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("- tenant: Tenant policy");
    expect(ctx.get(PendingSkillAnnouncementKey)).not.toContain("tenant/SKILL.md");
    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      tenant: [{ description: "Tenant policy", markdown: "Follow tenant policy.", name: "tenant" }],
    });

    enabled = false;
    await dispatch(ctx, resolver);

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("Available skills: none");
    expect(get).not.toHaveBeenCalled();
  });

  it("rebuilds the announcement after a step boundary without opening the sandbox", async () => {
    const { ctx, get } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => makeSkill("Tenant policy", "Body", { "a.md": "a" })),
    );
    get.mockClear();
    ctx.clearVirtualContext();

    await dispatchDynamicSkillEvent({
      ctx,
      event: { type: "step.started", data: {} } as UnstampedMessageStreamEvent,
      messages: [],
      resolvers: [],
    });

    expect(ctx.get(PendingSkillAnnouncementKey)).toContain(
      `- tenant: Tenant policy (path: $HOME/.agents/skills/tenant/SKILL.md)`,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("stores SKILL.md as authored, including frontmatter", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => makeSkill("Tenant", "---\nname: tenant\n---\n# Body\n")),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.[0]?.markdown).toBe(
      "---\nname: tenant\n---\n# Body\n",
    );
  });

  it("keeps remaining dynamic skills in the announcement when one resolver removes its skill", async () => {
    const { ctx } = createCtx();
    let tenantEnabled = true;
    const tenant = createResolver("tenant", () =>
      tenantEnabled ? makeSkill("Tenant policy") : null,
    );
    const support = createResolver("support", () => makeSkill("Support policy"));

    await dispatch(ctx, tenant, support);
    tenantEnabled = false;
    await dispatch(ctx, tenant, support);

    const announcement = ctx.get(PendingSkillAnnouncementKey);
    expect(announcement).not.toContain("tenant: Tenant policy");
    expect(announcement).toContain("support: Support policy");
  });

  it("names map entries by their bare key", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("custom", () => ({
        "talk-like-a-dog": makeSkill("Talk like a dog", "Woof."),
      })),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      custom: [{ description: "Talk like a dog", markdown: "Woof.", name: "talk-like-a-dog" }],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("talk-like-a-dog: Talk like a dog");
  });

  it("prefixes map entries with the mount namespace for an extension resolver", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver(
        "crm__playbooks",
        () => ({ triage: makeSkill("Triage an account", "Triage.") }),
        "crm",
      ),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      crm__playbooks: [
        { description: "Triage an account", markdown: "Triage.", name: "crm__triage" },
      ],
    });
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("crm__triage: Triage an account");
  });

  it("lets a dynamic skill override a same-named authored skill instead of throwing", async () => {
    const { ctx, sandbox } = createCtx(["talk-like-a-dog"]);
    await dispatch(
      ctx,
      createResolver("custom", () => ({
        "talk-like-a-dog": makeSkill("Dynamic override", "Woof.", { "notes.md": "Bark." }),
      })),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.custom?.[0]).toMatchObject({
      description: "Dynamic override",
      markdown: "Woof.",
      name: "talk-like-a-dog",
    });
    expect(writtenPaths(sandbox)).toEqual([
      `${SKILL_ROOT}/talk-like-a-dog/SKILL.md`,
      `${SKILL_ROOT}/talk-like-a-dog/notes.md`,
    ]);
  });

  it("collapses a directly-returned single defineSkill to the bare slug", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => makeSkill("Tenant policy")),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      tenant: [{ description: "Tenant policy", markdown: "Tenant policy", name: "tenant" }],
    });
  });

  it("throws and recommends manual namespacing when two resolvers emit the same name", async () => {
    const { ctx, sandbox } = createCtx();
    const alpha = createResolver("alpha", () => ({ shared: makeSkill("From alpha") }));
    const beta = createResolver("beta", () => ({ shared: makeSkill("From beta") }));

    await expect(dispatch(ctx, alpha, beta)).rejects.toThrow(
      /Dynamic skill "shared".*Namespace the map key manually/u,
    );

    expect(sandbox.writes).toEqual([]);
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
    expect(ctx.get(PendingSkillAnnouncementKey)).toBeUndefined();
  });
});

describe("dynamic skill supporting files", () => {
  it("writes a package with supporting files once and skips unchanged refreshes", async () => {
    const { ctx, get, sandbox } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "references/rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);

    expect(get).toHaveBeenCalledOnce();
    expect(writtenPaths(sandbox)).toEqual([
      `${SKILL_ROOT}/policy/SKILL.md`,
      `${SKILL_ROOT}/policy/references/rules.md`,
    ]);
    expect(ctx.get(DynamicSkillManifestKey)?.policy?.[0]?.revision).toMatch(/^[0-9a-f]{64}$/u);

    await dispatch(ctx, resolver);

    expect(get).toHaveBeenCalledOnce();
    expect(sandbox.writes).toHaveLength(2);
  });

  it("skips unchanged refreshes after durable state is resumed", async () => {
    const first = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "rules.md": "Rules" }),
    );
    await dispatch(first.ctx, resolver);

    const resumed = await deserializeContext(
      JSON.parse(
        JSON.stringify({
          [DynamicSkillManifestKey.name]: first.ctx.get(DynamicSkillManifestKey),
          [DynamicSkillSandboxKey.name]: first.ctx.get(DynamicSkillSandboxKey),
        }),
      ),
    );
    const get = vi.fn(async () => first.sandbox.session);
    resumed.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    resumed.set(SandboxKey, {
      captureState: async () => ({ session: first.state.session }),
      get,
      stop: async () => {},
    });
    await dispatch(resumed, resolver);

    expect(get).not.toHaveBeenCalled();
  });

  it("replaces a changed package so omitted files disappear", async () => {
    const { ctx, sandbox } = createCtx();
    let files: Record<string, string> = { "a.md": "A", "b.md": "B" };
    const resolver = createResolver("policy", () => makeSkill("Policy", "# Policy", files));

    await dispatch(ctx, resolver);
    files = { "a.md": "A2" };
    await dispatch(ctx, resolver);

    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A2");
    expect(sandbox.files.has(`${SKILL_ROOT}/policy/b.md`)).toBe(false);
  });

  it("rewrites unchanged packages for a different sandbox or after the sandbox is deleted", async () => {
    const { ctx, sandbox, state } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);
    state.session = persistedSandbox("sandbox-2");
    await dispatch(ctx, resolver);
    expect(sandbox.writes).toHaveLength(4);

    ctx.delete(DynamicSkillSandboxKey);
    await dispatch(ctx, resolver);
    expect(sandbox.writes).toHaveLength(6);
  });

  it("removes files when a package is withdrawn or loses its supporting files", async () => {
    const { ctx, sandbox } = createCtx();
    let result: SkillPackageDefinition | null = makeSkill("Policy", "# Policy", { "a.md": "A" });
    const resolver = createResolver("policy", () => result);

    await dispatch(ctx, resolver);
    result = makeSkill("Policy", "# Inline policy");
    await dispatch(ctx, resolver);

    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
    expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(false);
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});

    result = null;
    await dispatch(ctx, resolver);
    expect(sandbox.removedPaths).toHaveLength(2);
  });

  it("does not remove withdrawn files from a sandbox that never received them", async () => {
    const { ctx, get, sandbox, state } = createCtx();
    let enabled = true;
    const resolver = createResolver("policy", () =>
      enabled ? makeSkill("Policy", "# Policy", { "a.md": "A" }) : null,
    );

    await dispatch(ctx, resolver);
    state.session = persistedSandbox("replacement");
    enabled = false;
    await dispatch(ctx, resolver);

    expect(get).toHaveBeenCalledOnce();
    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`]);
  });

  it("keeps the previous manifest and rewrites a package after a failed write", async () => {
    const { ctx, sandbox } = createCtx();
    let content = "A";
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "a.md": content }),
    );
    await dispatch(ctx, resolver);
    const manifest = ctx.get(DynamicSkillManifestKey);

    content = "B";
    vi.spyOn(sandbox.session, "writeBinaryFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(dispatch(ctx, resolver)).rejects.toThrow("disk full");
    expect(ctx.get(DynamicSkillManifestKey)).toBe(manifest);
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});

    content = "A";
    await dispatch(ctx, resolver);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A");
  });
});
