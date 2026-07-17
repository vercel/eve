import { describe, expect, it } from "vitest";

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
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createCtx() {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  ctx.set(SessionIdKey, "test-session");
  ctx.set(SandboxKey, sandbox.access);
  return { ctx, sandbox };
}

function createResolver(
  slug: string,
  handler: () => SkillPackageDefinition | Record<string, SkillPackageDefinition> | null,
  eventNames: readonly ("session.started" | "turn.started")[] = ["session.started"],
): ResolvedDynamicSkillResolver {
  return {
    eventNames,
    events: Object.fromEntries(eventNames.map((eventName) => [eventName, handler])),
    exportName: "default",
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
  files?: Readonly<Record<string, string>>,
): SkillPackageDefinition {
  return defineSkill({ description, files, markdown });
}

async function dispatch(input: {
  readonly ctx: ContextContainer;
  readonly event?: "session.started" | "turn.started";
  readonly resolvers: readonly ResolvedDynamicSkillResolver[];
}): Promise<void> {
  await dispatchDynamicSkillEvent({
    ctx: input.ctx,
    event: makeEvent(input.event),
    messages: [],
    resolvers: input.resolvers,
  });
}

describe("dynamic skill materialization recovery", () => {
  it("migrates exact pre-marker packages instead of dropping them on an unmatched event", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver(
      "session-policy",
      () => makeSkill("Session policy", "Follow session policy."),
      ["session.started"],
    );
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;

    await dispatch({ ctx, event: "session.started", resolvers: [resolver] });
    sandbox.files.delete(markerPath);
    sandbox.fileBytes.delete(markerPath);
    ctx.clearVirtualContext();

    await dispatch({ ctx, event: "turn.started", resolvers: [resolver] });

    expect(ctx.get(DynamicSkillManifestKey)).toHaveProperty("session-policy");
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("session-policy: Session policy");
    expect(sandbox.files.has(markerPath)).toBe(true);
  });

  it("invalidates the old marker before a changed package can partially write", async () => {
    const { ctx, sandbox } = createCtx();
    let markdown = "Version one.";
    let files: Readonly<Record<string, string>> = {};
    const resolver = createResolver("tenant", () => makeSkill("Tenant policy", markdown, files));
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;

    await dispatch({ ctx, resolvers: [resolver] });
    expect(sandbox.files.has(markerPath)).toBe(true);

    markdown = "Partial version two.";
    files = { "references/fail.md": "fail" };
    const failingSession = {
      ...sandbox.session,
      async writeBinaryFile(options: Parameters<typeof sandbox.session.writeBinaryFile>[0]) {
        if (options.path.endsWith("/references/fail.md")) {
          throw new Error("injected changed-package write failure");
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

    await expect(dispatch({ ctx, resolvers: [resolver] })).rejects.toThrow(
      "injected changed-package write failure",
    );
    expect(sandbox.files.has(markerPath)).toBe(false);

    markdown = "Version one.";
    files = {};
    ctx.set(SandboxKey, sandbox.access);
    await dispatch({ ctx, resolvers: [resolver] });

    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/SKILL.md")).toBe("Version one.");
  });

  it("retires packages owned by resolvers removed from the compiled inventory", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("retired", () => makeSkill("Retired policy", "Retired body."));

    await dispatch({ ctx, resolvers: [resolver] });
    ctx.clearVirtualContext();
    await dispatch({ ctx, resolvers: [] });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("");
    expect(sandbox.files.has("/home/agent/.agents/skills/retired/SKILL.md")).toBe(false);
  });

  it("never uses an injected marker package as recursive-delete authority", async () => {
    const { ctx, sandbox } = createCtx();
    const resolver = createResolver("tenant", () => makeSkill("Tenant policy", "Tenant body."));
    const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
    const authoredPath = "/home/agent/.agents/skills/authored/SKILL.md";

    await dispatch({ ctx, resolvers: [resolver] });
    sandbox.files.set(authoredPath, "Authored body.");
    sandbox.fileBytes.set(authoredPath, Buffer.from("Authored body."));
    const marker = JSON.parse(sandbox.files.get(markerPath)!) as {
      packages: Record<string, unknown>;
      version: number;
    };
    marker.packages.authored = marker.packages.tenant;
    const injected = `${JSON.stringify(marker)}\n`;
    sandbox.files.set(markerPath, injected);
    sandbox.fileBytes.set(markerPath, Buffer.from(injected));

    await dispatch({ ctx, resolvers: [resolver] });

    expect(sandbox.files.get(authoredPath)).toBe("Authored body.");
  });

  it.each(["modified", "missing"] as const)(
    "repairs %s managed package bytes instead of trusting a warm marker",
    async (state) => {
      const { ctx, sandbox } = createCtx();
      const resolver = createResolver("tenant", () => makeSkill("Tenant policy", "Trusted body."));
      const skillPath = "/home/agent/.agents/skills/tenant/SKILL.md";

      await dispatch({ ctx, resolvers: [resolver] });
      if (state === "modified") {
        sandbox.files.set(skillPath, "Injected body.");
        sandbox.fileBytes.set(skillPath, Buffer.from("Injected body."));
      } else {
        sandbox.files.delete(skillPath);
        sandbox.fileBytes.delete(skillPath);
      }

      await dispatch({ ctx, resolvers: [resolver] });

      expect(sandbox.files.get(skillPath)).toBe("Trusted body.");
    },
  );

  it("does not re-announce session skills after sandbox replacement on an unmatched event", async () => {
    const { ctx } = createCtx();
    const resolver = createResolver(
      "session-policy",
      () => makeSkill("Session policy", "Follow session policy."),
      ["session.started"],
    );
    await dispatch({ ctx, event: "session.started", resolvers: [resolver] });
    ctx.clearVirtualContext();

    const recreated = mockSandbox({
      id: "sbx_recreated",
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });
    ctx.set(SandboxKey, recreated.access);
    await dispatch({ ctx, event: "turn.started", resolvers: [resolver] });

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe("");
    expect(recreated.files.has("/home/agent/.agents/skills/session-policy/SKILL.md")).toBe(false);
  });

  it.each(["missing", "stale"] as const)(
    "invalidates unresolvable manifest packages after a %s marker",
    async (markerState) => {
      const { ctx, sandbox } = createCtx();
      const sessionResolver = createResolver(
        "session-policy",
        () => makeSkill("Session policy", "Follow session policy."),
        ["session.started"],
      );
      const turnResolver = createResolver(
        "turn-policy",
        () => makeSkill("Turn policy", "Follow turn policy."),
        ["turn.started"],
      );
      const resolvers = [sessionResolver, turnResolver];

      await dispatch({ ctx, event: "session.started", resolvers });
      await dispatch({ ctx, event: "turn.started", resolvers });
      expect(ctx.get(PendingSkillAnnouncementKey)).toContain("session-policy: Session policy");

      let activeSandbox = sandbox;
      if (markerState === "missing") {
        activeSandbox = mockSandbox({
          id: "sbx_recreated",
          commands: {
            [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
          },
        });
        ctx.set(SandboxKey, activeSandbox.access);
      } else {
        const markerPath = `/home/agent/.agents/skills/${DYNAMIC_SKILL_MATERIALIZATION_MARKER_FILE}`;
        const marker = JSON.parse(sandbox.files.get(markerPath)!) as {
          packages: Record<string, unknown>;
          version: number;
        };
        delete marker.packages["session-policy"];
        const staleMarker = JSON.stringify(marker);
        sandbox.files.set(markerPath, staleMarker);
        sandbox.fileBytes.set(markerPath, Buffer.from(staleMarker));
      }

      await dispatch({ ctx, event: "turn.started", resolvers });

      expect(ctx.get(DynamicSkillManifestKey)).toEqual({
        "turn-policy": [
          {
            contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            description: "Turn policy",
            name: "turn-policy",
            relativePaths: ["SKILL.md"],
          },
        ],
      });
      expect(ctx.get(PendingSkillAnnouncementKey)).not.toContain("session-policy: Session policy");
      expect(ctx.get(PendingSkillAnnouncementKey)).toContain("turn-policy: Turn policy");
      expect(activeSandbox.files.has("/home/agent/.agents/skills/session-policy/SKILL.md")).toBe(
        false,
      );
      expect(activeSandbox.files.get("/home/agent/.agents/skills/turn-policy/SKILL.md")).toBe(
        "Follow turn policy.",
      );
    },
  );

  it("clears stale siblings when retrying a partial first materialization", async () => {
    const { ctx, sandbox } = createCtx();
    let files: Readonly<Record<string, string>> = {
      "references/stale.md": "Stale body",
      "scripts/fail.sh": "exit 1",
    };
    const resolver = createResolver("tenant", () =>
      makeSkill("Tenant policy", "Follow tenant policy.", files),
    );
    const failingSession = {
      ...sandbox.session,
      async writeBinaryFile(options: Parameters<typeof sandbox.session.writeBinaryFile>[0]) {
        if (options.path.endsWith("/scripts/fail.sh")) {
          throw new Error("injected final write failure");
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

    await expect(dispatch({ ctx, resolvers: [resolver] })).rejects.toThrow(
      "injected final write failure",
    );
    expect(sandbox.files.has("/home/agent/.agents/skills/tenant/references/stale.md")).toBe(true);
    expect(ctx.get(DynamicSkillManifestKey)).toHaveProperty("tenant");

    files = {};
    ctx.set(SandboxKey, sandbox.access);
    await dispatch({ ctx, resolvers: [resolver] });

    expect(sandbox.files.has("/home/agent/.agents/skills/tenant/references/stale.md")).toBe(false);
    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/SKILL.md")).toBe(
      "Follow tenant policy.",
    );
  });

  it("replaces one dynamic skill name with another", async () => {
    const { ctx, sandbox } = createCtx();
    let name = "old-policy";
    const resolver = createResolver("policies", () => ({
      [name]: makeSkill(`${name} description`, `${name} body`),
    }));

    await dispatch({ ctx, resolvers: [resolver] });
    name = "new-policy";
    await dispatch({ ctx, resolvers: [resolver] });

    expect(sandbox.files.has("/home/agent/.agents/skills/old-policy/SKILL.md")).toBe(false);
    expect(sandbox.files.get("/home/agent/.agents/skills/new-policy/SKILL.md")).toBe(
      "new-policy body",
    );
    expect(ctx.get(PendingSkillAnnouncementKey)).not.toContain("old-policy description");
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("new-policy: new-policy description");
  });
});
