import { describe, expect, it, vi } from "vitest";
import type { EveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyWebSetup, prepareWebSetup, type WebSetupDeps } from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn<WebSetupDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "lockfile",
    })),
    pathExists: vi.fn(async () => false),
    readTextFile: vi.fn(async () => '{"scripts":{"dev":"eve dev"}}\n'),
    resolveEveProjectContext: vi.fn(async (appRoot: string): Promise<EveProjectContext> => ({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    })),
    syncHostFrameworkPreset: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Web setup", () => {
  it("presents the hosting topology with stacked guidance", async () => {
    const effects = deps();
    const fake = createFakePrompter({ single: () => "vercel" });
    const select = vi.spyOn(fake.prompter, "select");
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: interactiveAsker(fake.prompter),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await prepareWebSetup(ctx.prepare, effects);

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How should Web Chat and agent requests be routed?",
        hintLayout: "stacked",
        initialValue: "vercel",
        options: [
          {
            value: "vercel",
            label: "Vercel peer services (Recommended for Vercel)",
            hint: "Route Web Chat and each agent directly as separate services.",
            featured: undefined,
          },
          {
            value: "next",
            label: "Through Next.js",
            hint: "Route Web Chat and all agent requests through one Next.js app.",
            featured: undefined,
          },
        ],
      }),
    );
  });

  it("requires a linked project when Vercel is selected", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "web-hosting": "vercel" })(headlessAsker()),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });

    await expect(prepareWebSetup(ctx.prepare, effects)).resolves.toEqual({
      hosting: "vercel",
      packageManager: "pnpm",
    });
    expect(resolveVercelProject).toHaveBeenCalledWith("Web Chat");
  });

  it("does not require a Vercel project for other hosts", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => {
      throw new Error("eve link");
    });
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "web-hosting": "next" })(headlessAsker()),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });

    await expect(prepareWebSetup(ctx.prepare, effects)).resolves.toEqual({
      hosting: "next",
      packageManager: "pnpm",
    });
    expect(resolveVercelProject).not.toHaveBeenCalled();
  });

  it("rejects an unselected workspace before writing an agent directory", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue({
      environmentRoot: "/project",
      kind: "workspace",
      workspace: {
        root: "/project",
        members: [{ appRoot: "/project/agents/support", name: "support" }],
      },
    });
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await expect(
      applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects),
    ).rejects.toThrow("Web Chat setup requires a selected workspace agent.");

    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("writes the selected member channel and configures the workspace Web Chat target", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue({
      environmentRoot: "/project",
      kind: "workspace-member",
      member: { appRoot: "/project/agents/support", name: "support" },
      workspace: {
        root: "/project",
        members: [{ appRoot: "/project/agents/support", name: "support" }],
      },
    });
    const ctx = createSetupContexts({
      appRoot: "/project/agents/support",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects);

    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      1,
      "/project/agents/support/agent/channels/eve.ts",
      expect.any(String),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      2,
      "/project/apps/web/app/eve-agent.ts",
      expect.stringContaining('WEB_CHAT_AGENT: string | undefined = "support"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.stringContaining('root: "apps/web"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev": "eve dev"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev:services": "vercel dev"'),
      { force: true },
    );
    expect(effects.syncHostFrameworkPreset).toHaveBeenCalledWith(
      ctx.apply.presenter,
      "/project",
      expect.any(Function),
      { signal: undefined },
    );
  });

  it("preserves an authored default development script", async () => {
    const effects = deps();
    vi.mocked(effects.readTextFile).mockResolvedValue('{"scripts":{"dev":"custom-dev"}}\n');
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, ctx.apply, effects);

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev": "custom-dev"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev:services": "vercel dev"'),
      { force: true },
    );
  });

  it("configures Vercel services for a standalone agent and returns the local command", async () => {
    const effects = deps();
    const fake = createFakePrompter();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await expect(
      applyWebSetup({ hosting: "vercel", packageManager: "npm" }, ctx.apply, effects),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `npm run dev:services`." }],
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/eve.ts",
      expect.any(String),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      2,
      "/project/apps/web/app/eve-agent.ts",
      expect.stringContaining("WEB_CHAT_AGENT: string | undefined = undefined"),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenNthCalledWith(
      3,
      "/project/apps/web/next.config.ts",
      expect.stringContaining("export default nextConfig"),
      { force: true },
    );
    expect(fake.prompter.note).not.toHaveBeenCalled();
  });

  it("configures Next.js hosting for other platforms", async () => {
    const effects = deps();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await expect(
      applyWebSetup({ hosting: "next", packageManager: "yarn" }, ctx.apply, effects),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `yarn dev:web`." }],
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/apps/web/next.config.ts",
      expect.stringContaining('fileURLToPath(new URL("../..", import.meta.url))'),
      { force: true },
    );
    expect(effects.writeTextFile).not.toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.anything(),
      expect.anything(),
    );
  });
});
