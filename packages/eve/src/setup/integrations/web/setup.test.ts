import { describe, expect, it, vi } from "vitest";
import type { EveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyWebSetup, type WebSetupDeps } from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn(async () => ({
      kind: "pnpm" as const,
      source: "lockfile" as const,
    })),
    pathExists: vi.fn(async () => false),
    resolveEveProjectContext: vi.fn(async (appRoot: string): Promise<EveProjectContext> => ({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Web setup", () => {
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
      applyWebSetup({ hosting: "vercel-services", packageManager: "pnpm" }, ctx.apply, effects),
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
    await applyWebSetup({ hosting: "vercel-services", packageManager: "pnpm" }, ctx.apply, effects);

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
  });

  it("configures peer services for a standalone agent", async () => {
    const effects = deps();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await applyWebSetup({ hosting: "vercel-services", packageManager: "pnpm" }, ctx.apply, effects);
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
  });
});
