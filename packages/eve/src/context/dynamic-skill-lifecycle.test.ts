import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import {
  StaticModelReferenceKey,
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  SessionIdKey,
  SandboxKey,
} from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  EVE_NAMESPACE_NAMES,
  EVE_NAMESPACE_RESERVATION,
  NAMES_OUTSIDE_EVE_NAMESPACE,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type {
  SandboxAccess,
  SandboxPreparation,
  SandboxSessionState,
  SandboxState,
} from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#sandbox/provider.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";

// Sandbox start loads the prepared artifact; these tests prepare none.
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

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

/**
 * A provider that, like the built-in ones, names a session's sandbox the same
 * way on every start, and whose sandbox can be removed outside eve.
 */
function recreatableSandbox() {
  const sandboxes: ReturnType<typeof mockSandbox>[] = [];
  let gone = false;
  const environment = defineSandboxProvider({
    name: "recreatable",
    environment: () => ({
      onSessionEnd: async () => {},
      prepare: async () => null,
      async resume() {
        if (gone) {
          gone = false;
          throw new SandboxSessionGoneError("The sandbox was removed.");
        }
        return sandboxes.at(-1)!.connection;
      },
      async start(context) {
        const sandbox = mockSandbox({
          commands: {
            [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
          },
        });
        sandboxes.push(sandbox);
        return { connection: sandbox.connection, state: { name: `sandbox-${context.session.id}` } };
      },
    }),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(() => environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { registry, removeOutsideEve: () => void (gone = true), sandboxes };
}

/**
 * Mirrors ensureSandboxAccess: queued work runs in order, and `get()` and
 * `settle()` wait for it. A failed job is dropped; retrying it is the queue's
 * concern, not this file's.
 */
function createAccess(
  open: () => Promise<SandboxSession>,
  captureState: () => Promise<SandboxState>,
) {
  let queue: Promise<void> = Promise.resolve();
  return {
    captureState,
    async get() {
      await queue;
      return await open();
    },
    open,
    prepare(work?: SandboxPreparation) {
      queue = queue
        .then(async () => {
          if (work === undefined) await open();
          else await work(open);
        })
        .catch(() => undefined);
    },
    settle: () => queue,
    stop: async () => {},
  } satisfies SandboxAccess & { settle(): Promise<void> };
}

/** The persisted state appears once the sandbox opens. */
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
  const open = vi.fn(async () => {
    state.session ??= persistedSandbox(state.next);
    return sandbox.session;
  });
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "test-session");
  const access = createAccess(open, async () => ({ session: state.session }));
  ctx.setVirtualContext(SandboxKey, access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames));
  return { access, ctx, open, sandbox, state };
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

/** Waits for the sandbox work queued on the context's access, as a step's commit does. */
async function settle(ctx: ContextContainer): Promise<void> {
  await (ctx.require(SandboxKey) as SandboxAccess & { settle(): Promise<void> }).settle();
}

/** Dispatches, then waits for the sandbox work it queued, as a step's commit does. */
async function dispatch(ctx: ContextContainer, ...resolvers: ResolvedDynamicSkillResolver[]) {
  await dispatchDynamicSkillEvent({ ctx, event: makeEvent(), messages: [], resolvers });
  await settle(ctx);
}

function writtenPaths(sandbox: ReturnType<typeof mockSandbox>): string[] {
  return sandbox.writes.map((write) => write.path);
}

describe("dispatchDynamicSkillEvent", () => {
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
  });

  it("accepts a skill name that starts with a digit", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => ({ "3d-modeling": makeSkill("Model in 3D", "Model.") })),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.map((skill) => skill.name)).toEqual([
      "3d-modeling",
    ]);
  });

  it.each(EVE_NAMESPACE_NAMES)(
    "skips a resolver that returns %s, in eve's namespace",
    async (name) => {
      const logs = captureLogRecords();
      const { ctx } = createCtx();
      await dispatch(
        ctx,
        createResolver("tenant", () => ({
          [name]: makeSkill("Reserved"),
          policy: makeSkill("Tenant policy"),
        })),
      );

      expect(ctx.get(DynamicSkillManifestKey)?.tenant).toBeUndefined();
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          fields: {
            error: expect.stringContaining(
              `Dynamic skill resolver "skills/tenant.ts" returned the reserved skill name "${name}". ${EVE_NAMESPACE_RESERVATION}; rename the skill.`,
            ),
          },
          level: "error",
        }),
      );
    },
  );

  it("keeps skills outside eve's namespace, including the built-in tools' former names", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () =>
        Object.fromEntries(NAMES_OUTSIDE_EVE_NAMESPACE.map((name) => [name, makeSkill(name)])),
      ),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.map((skill) => skill.name)).toEqual(
      NAMES_OUTSIDE_EVE_NAMESPACE,
    );
  });

  it("skips a resolver that returns an illegal skill name", async () => {
    const logs = captureLogRecords();
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => ({
        "release notes": makeSkill("Release notes"),
        policy: makeSkill("Tenant policy"),
      })),
      createResolver("support", () => makeSkill("Support policy")),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      support: [{ description: "Support policy", markdown: "Support policy", name: "support" }],
    });
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        fields: {
          error: expect.stringContaining(
            'Dynamic skill resolver "skills/tenant.ts" returned illegal skill name "release notes".',
          ),
        },
        level: "error",
      }),
    );
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
  });
});

describe("dynamic skill supporting files", () => {
  it("returns before the sandbox opens, and writes the files once it does", async () => {
    const { ctx, open, sandbox } = createCtx();
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const openNow = open.getMockImplementation()!;
    open.mockImplementationOnce(async () => {
      await gate;
      return await openNow();
    });
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "rules.md": "Rules" }),
    );

    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(DynamicSkillManifestKey)?.policy?.[0]?.markdown).toBe("# Policy");
    expect(sandbox.writes).toEqual([]);
    opened();
    await settle(ctx);
    expect(writtenPaths(sandbox)).toContain(`${SKILL_ROOT}/policy/rules.md`);
  });

  it("writes a package with supporting files once and skips unchanged refreshes", async () => {
    const { ctx, open, sandbox } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "references/rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);

    expect(open).toHaveBeenCalledOnce();
    expect(writtenPaths(sandbox)).toEqual([
      `${SKILL_ROOT}/policy/SKILL.md`,
      `${SKILL_ROOT}/policy/references/rules.md`,
    ]);
    expect(ctx.get(DynamicSkillManifestKey)?.policy?.[0]?.revision).toMatch(/^[0-9a-f]{64}$/u);

    await dispatch(ctx, resolver);

    expect(open).toHaveBeenCalledOnce();
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
    const open = vi.fn(async () => first.sandbox.session);
    resumed.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    resumed.set(
      SandboxKey,
      createAccess(open, async () => ({ session: first.state.session })),
    );
    await dispatch(resumed, resolver);

    expect(open).not.toHaveBeenCalled();
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

  it("rewrites unchanged packages for a different sandbox", async () => {
    const { ctx, sandbox, state } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);
    state.session = persistedSandbox("sandbox-2");
    await dispatch(ctx, resolver);
    expect(sandbox.writes).toHaveLength(4);
  });

  it("writes files into a sandbox recreated after it was gone, at the next turn", async () => {
    const { registry, removeOutsideEve, sandboxes } = recreatableSandbox();
    const ctx = new ContextContainer();
    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    ctx.set(SessionIdKey, "session-1");
    ctx.set(BundleKey, createMockBundle());
    const handler = () => makeSkill("Policy", "# Policy", { "rules.md": "Rules" });
    const resolver: ResolvedDynamicSkillResolver = {
      ...createResolver("policy", handler),
      eventNames: ["turn.started"],
      events: { "turn.started": handler },
    };
    // Each turn resumes from the state the previous turn checkpointed.
    let state: SandboxState | null = null;
    const turn = async (work?: (access: SandboxAccess) => Promise<unknown>) => {
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry,
        sessionId: "session-1",
        state,
      });
      ctx.setVirtualContext(SandboxKey, access);
      await dispatchDynamicSkillEvent({
        ctx,
        event: { data: {}, type: "turn.started" } as UnstampedMessageStreamEvent,
        messages: [],
        resolvers: [resolver],
      });
      await work?.(access);
      await access.settle();
      state = await access.captureState();
    };
    const rules = (index: number) => sandboxes[index]?.files.get(`${SKILL_ROOT}/policy/rules.md`);

    await turn();
    expect(rules(0)).toBe("Rules");

    // The turn starts with the files counted as written; a tool then finds the
    // sandbox gone, and eve starts a fresh one under the same provider state.
    removeOutsideEve();
    await turn(async (access) => await access.get());
    expect(sandboxes).toHaveLength(2);
    expect(rules(1)).toBeUndefined();

    await turn();
    expect(rules(1)).toBe("Rules");

    // Resuming keeps the identity, so nothing is written again.
    const writes = sandboxes[1]!.writes.length;
    await turn();
    expect(sandboxes[1]!.writes).toHaveLength(writes);
  });

  it("removes files when a package is withdrawn", async () => {
    const { ctx, sandbox } = createCtx();
    let result: SkillPackageDefinition | null = makeSkill("Policy", "# Policy", { "a.md": "A" });
    const resolver = createResolver("policy", () => result);

    await dispatch(ctx, resolver);
    result = null;
    await dispatch(ctx, resolver);

    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
    expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(false);
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
  });

  it("keeps files when a package loses its supporting files", async () => {
    const { ctx, open, sandbox } = createCtx();
    let result = makeSkill("Policy", "# Policy", { "a.md": "A" });
    const resolver = createResolver("policy", () => result);

    await dispatch(ctx, resolver);
    result = makeSkill("Policy", "# Inline policy");
    await dispatch(ctx, resolver);

    expect(open).toHaveBeenCalledOnce();
    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`]);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A");
  });

  it("removes kept files when a package that lost its supporting files is withdrawn", async () => {
    const { ctx, sandbox } = createCtx();
    let result: SkillPackageDefinition | null = makeSkill("Policy", "# Policy", { "a.md": "A" });
    const resolver = createResolver("policy", () => result);

    await dispatch(ctx, resolver);
    result = makeSkill("Policy", "# Inline policy");
    await dispatch(ctx, resolver);
    result = null;
    await dispatch(ctx, resolver);

    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
    expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(false);
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
  });

  it("does not remove withdrawn files from a sandbox that never received them", async () => {
    const { ctx, open, sandbox, state } = createCtx();
    let enabled = true;
    const resolver = createResolver("policy", () =>
      enabled ? makeSkill("Policy", "# Policy", { "a.md": "A" }) : null,
    );

    await dispatch(ctx, resolver);
    state.session = persistedSandbox("replacement");
    enabled = false;
    await dispatch(ctx, resolver);

    expect(open).toHaveBeenCalledOnce();
    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`]);
  });

  it("forgets a changed package before its queued write runs, so a failure is redone", async () => {
    const { access, ctx, sandbox } = createCtx();
    let content = "A";
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "a.md": content }),
    );
    await dispatch(ctx, resolver);
    expect(ctx.get(DynamicSkillSandboxKey)).toHaveProperty("policy");

    // Fails however often the queue retries, until the provider recovers.
    let unavailable = true;
    const captureState = access.captureState;
    vi.spyOn(access, "captureState").mockImplementation(async () => {
      if (unavailable) throw new Error("provider unavailable");
      return await captureState();
    });
    content = "B";
    await dispatchDynamicSkillEvent({
      ctx,
      event: makeEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
    await settle(ctx);

    unavailable = false;
    await dispatch(ctx, resolver);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("B");
  });

  it("rewrites a package after a failed write", async () => {
    const { ctx, sandbox } = createCtx();
    let content = "A";
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "a.md": content }),
    );
    await dispatch(ctx, resolver);

    content = "B";
    let full = true;
    const writeFiles = sandbox.session.writeFiles;
    vi.spyOn(sandbox.session, "writeFiles").mockImplementation(async (options) => {
      if (full) throw new Error("disk full");
      await writeFiles(options);
    });
    await dispatch(ctx, resolver);
    expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
    full = false;

    content = "A";
    await dispatch(ctx, resolver);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A");
  });
});
