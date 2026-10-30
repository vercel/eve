import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { pathExists, writeTextFile } from "#setup/scaffold/files.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  WEB_APP_TEMPLATE_FILES,
  WEB_CHANNEL_TEMPLATES,
} from "#setup/scaffold/create/web-template.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";
import { applyWebSetup, prepareWebSetup, type WebSetupDeps } from "./setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(member = "", webDirectory = "apps/web") {
  const environmentRoot = await mkdtemp(join(tmpdir(), "eve-web-auth-"));
  roots.push(environmentRoot);
  const agentAppRoot = join(environmentRoot, member);
  const channelPath = join(agentAppRoot, "agent/channels/eve.ts");
  const packagePath = join(environmentRoot, "package.json");
  await mkdir(dirname(channelPath), { recursive: true });
  await writeFile(channelPath, WEB_CHANNEL_TEMPLATES.default);
  await writeFile(
    packagePath,
    JSON.stringify({
      scripts: { "dev:all": "vercel dev --local" },
      dependencies: { eve: "latest" },
    }),
  );
  for (const [path, source] of Object.entries(WEB_APP_TEMPLATE_FILES)) {
    const file = join(environmentRoot, webDirectory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      source
        .replaceAll("__EVE_INIT_APP_NAME__", "eve Next.js Starter")
        .replaceAll("__EVE_INIT_WITH_EVE_OPTIONS__", ""),
    );
  }
  return { environmentRoot, agentAppRoot, channelPath, packagePath };
}

describe("Web Chat auth scaffold", () => {
  it("adds auth to an existing root Web Chat without relocating it and can be retried", async () => {
    const { environmentRoot: appRoot, channelPath } = await fixture("", "");
    const nextConfig = await readFile(join(appRoot, "next.config.ts"), "utf8");
    const contexts = createSetupContexts({
      appRoot,
      asker: withAnswers({ "web-authentication": "vercel" })(headlessAsker()),
      environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team_example", projectId: "prj_example" }),
    });
    const deps: WebSetupDeps = {
      detectPackageManager,
      pathExists,
      readTextFile: (path) => readFile(path, "utf8"),
      resolveEveProjectContext,
      writeTextFile,
      prepareWebAuthScaffold,
      provisionWebChatAuth: async () => {},
      installScaffoldDependencies: async () => {},
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plan = await prepareWebSetup(contexts.prepare, deps);
      const result = await applyWebSetup(plan, contexts.apply, deps);
      expect(result.deploymentRequired).toBe(true);
    }
    expect(await readFile(join(appRoot, "next.config.ts"), "utf8")).toBe(nextConfig);
    const importPath = /import \{ auth \} from "(.+)"/.exec(
      await readFile(channelPath, "utf8"),
    )?.[1];
    expect(importPath).toBeDefined();
    expect(resolve(dirname(channelPath), importPath!)).toBe(join(appRoot, "lib/auth.js"));
    expect(await pathExists(join(appRoot, "apps/web"))).toBe(false);
  });

  it.each(["", "agents/support"])(
    "wires the real channel to the shared auth module from %s and can be retried",
    async (member) => {
      const input = await fixture(member);
      const layoutPath = join(input.environmentRoot, "apps/web/app/layout.tsx");
      const layout = await readFile(layoutPath, "utf8");
      const write = await prepareWebAuthScaffold(input);
      await write();
      const signIn = await readFile(
        join(input.environmentRoot, "apps/web/app/_components/web-chat-auth.tsx"),
        "utf8",
      );
      expect(signIn).toContain(JSON.stringify(basename(input.agentAppRoot)));
      expect(signIn).not.toContain("__EVE_INIT_APP_NAME__");
      const channel = await readFile(input.channelPath, "utf8");
      const importPath = /import \{ auth \} from "(.+)"/.exec(channel)?.[1];
      expect(importPath).toBeDefined();
      expect(resolve(dirname(input.channelPath), importPath!)).toBe(
        join(input.environmentRoot, "apps/web/lib/auth.js"),
      );
      expect(await readFile(join(input.environmentRoot, "apps/web/lib/auth.ts"), "utf8")).toContain(
        'requireEnvironmentVariable("BETTER_AUTH_SECRET")',
      );
      const document = JSON.parse(await readFile(input.packagePath, "utf8"));
      expect(document.dependencies["better-auth"]).toBeDefined();
      expect(document.scripts["dev:all"]).toBe("vercel dev --local");
      expect(await readFile(layoutPath, "utf8")).toBe(layout);
      await (
        await prepareWebAuthScaffold(input)
      )();
      expect(await readFile(input.channelPath, "utf8")).toBe(channel);
    },
  );

  it("rejects custom auth before the caller provisions resources or writes files", async () => {
    const input = await fixture();
    await writeFile(input.channelPath, "// existing application auth\n");
    await expect(prepareWebAuthScaffold(input)).rejects.toThrow("contains authored code");
    expect(await readFile(input.channelPath, "utf8")).toBe("// existing application auth\n");
    expect(
      JSON.parse(await readFile(input.packagePath, "utf8")).dependencies["better-auth"],
    ).toBeUndefined();
  });
});
