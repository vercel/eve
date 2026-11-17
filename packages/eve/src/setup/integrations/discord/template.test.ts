import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyDiscordSetup, prepareDiscordSetup, type DiscordSetupDeps } from "./setup.js";

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../../../../apps/templates/eve-discord-agent-template/", import.meta.url),
);
const PROJECT_ROOT = "/project";

async function runSetup(): Promise<{ files: Map<string, string>; connectorUid: string }> {
  const files = new Map<string, string>();
  let connectorUid = "";
  const deps: DiscordSetupDeps = {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => await deriveSlackConnectorSlug(TEMPLATE_ROOT)),
    enableMessageContent: vi.fn(async () => true),
    provisionConnector: vi.fn(async ({ slug }) => {
      connectorUid = `discord/${slug}`;
      return { id: "connector", uid: connectorUid };
    }),
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
  return { files, connectorUid };
}

const readTemplateFile = (path: string) => readFile(join(TEMPLATE_ROOT, path), "utf8");

describe("eve-discord-agent-template", () => {
  it("matches the files Discord Gateway setup generates", async () => {
    const { files: generated, connectorUid } = await runSetup();
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
        const manifest = JSON.parse(content) as { dependencies: Record<string, string> };
        for (const name of Object.keys(manifest.dependencies)) {
          manifest.dependencies[name] = rootDependencies[name]!;
        }
        expected = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      if (path === "daemon/main.ts") {
        expected = expected
          .replace(
            'import { runDiscordGatewayRelay } from "eve/experimental/channels/discord/gateway";',
            'import { experimental_runDiscordGatewayRelay } from "eve/channels/discord/gateway";',
          )
          .replace("await runDiscordGatewayRelay(", "await experimental_runDiscordGatewayRelay(");
      }
      expect(await readTemplateFile(path), path).toBe(expected);
    }
    expect(await readTemplateFile("agent/tools/read_recent_messages.ts")).toContain(
      `const DISCORD_CONNECTOR = ${JSON.stringify(connectorUid)};`,
    );
  });
});
