import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyDiscordSetup, prepareDiscordSetup, type DiscordSetupDeps } from "./setup.js";

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../../../../apps/templates/eve-discord-agent-template/", import.meta.url),
);
const PROJECT_ROOT = "/project";

/** Runs the Gateway setup against an empty project and returns the files it writes. */
async function generatedFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const deps: DiscordSetupDeps = {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "my-agent" as never),
    enableMessageContent: vi.fn(async () => true),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "discord/my-agent" })),
    readTextFile: vi.fn(async () => undefined),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({ id: "app", name: "Agent", publicKey: "key" })),
    writeTextFile: vi.fn(async (path: string, content: string) => {
      files.set(relative(PROJECT_ROOT, path), content);
    }),
  };
  const ctx = createSetupContexts({
    appRoot: PROJECT_ROOT,
    asker: withAnswers({ "discord-messages": "gateway", "discord-bot-token": "bot-token" })(
      headlessAsker(),
    ),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
  await applyDiscordSetup(await prepareDiscordSetup(ctx.prepare, deps), ctx.apply, deps);
  return files;
}

const readTemplateFile = (path: string) => readFile(join(TEMPLATE_ROOT, path), "utf8");

// The template ships what `eve add channel/discord` writes, so re-running setup in it only
// swaps in the connector's ID. A setup change that isn't copied to the template fails here.
describe("eve-discord-agent-template", () => {
  it("matches the files Discord Gateway setup generates", async () => {
    const generated = await generatedFiles();
    const rootDependencies = (
      JSON.parse(await readTemplateFile("package.json")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;

    expect([...generated.keys()].sort()).toEqual([
      "agent/channels/discord.ts",
      "daemon/.dockerignore",
      "daemon/Dockerfile",
      "daemon/main.ts",
      "daemon/package.json",
      "vercel.json",
    ]);
    for (const [path, content] of generated) {
      let expected = content;
      if (path === "daemon/package.json") {
        // Setup stamps the running eve's versions; the template pins the ones its agent uses.
        const manifest = JSON.parse(content) as { dependencies: Record<string, string> };
        for (const name of Object.keys(manifest.dependencies)) {
          manifest.dependencies[name] = rootDependencies[name]!;
        }
        expected = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      expect(await readTemplateFile(path), path).toBe(expected);
    }
    // Setup doesn't rewrite the tool, so it has to start on the same placeholder.
    expect(await readTemplateFile("agent/tools/read_recent_messages.ts")).toContain(
      'const DISCORD_CONNECTOR = "discord/my-agent";',
    );
  });
});
