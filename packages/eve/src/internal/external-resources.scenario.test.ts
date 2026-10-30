import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createConnectManifest } from "#internal/external-resources.js";
import { createExternalResourcesSnapshot } from "#internal/external-resources-snapshot.js";
import { resolveScenarioPackageVersion, useScenarioApp } from "#internal/testing/scenario-app.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";

async function createAppWithCompiler(source: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-connect-compiler-"));
  const packageRoot = join(appRoot, "node_modules", "@vercel", "connect");
  await mkdir(join(packageRoot, "dist", "manifest"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      exports: { "./manifest": "./dist/manifest/index.js" },
      name: "@vercel/connect",
      type: "module",
    }),
  );
  await writeFile(join(packageRoot, "dist", "manifest", "index.js"), source);
  return appRoot;
}

const snapshot = createExternalResourcesSnapshot({
  generatorVersion: "1.2.3",
  resources: [
    {
      credentials: {
        reference: "connector:linear/my-agent",
        service: "linear",
        subjectTypes: ["user"],
      },
      kind: "connection",
      logicalPath: "connections/linear.ts",
      name: "linear",
      protocol: { type: "mcp", url: "https://mcp.linear.app/mcp" },
    },
  ],
});

describe("Connect manifest compiler handoff", () => {
  const scenarioApp = useScenarioApp();

  it("emits a manifest from the installed Connect compiler during a real build", async () => {
    const connectVersion = await resolveScenarioPackageVersion("@vercel/connect");
    const app = await scenarioApp({
      dependencies: { "@vercel/connect": connectVersion },
      files: {
        "agent/agent.ts": [
          'import { defineAgent } from "eve";',
          "",
          'export default defineAgent({ model: "openai/gpt-5-mini" });',
          "",
        ].join("\n"),
        "agent/channels/slack.ts": [
          'import { connectSlackCredentials } from "@vercel/connect/eve";',
          'import { slackChannel } from "eve/channels/slack";',
          "",
          "export default slackChannel({",
          '  credentials: connectSlackCredentials("slack/manifest-test"),',
          "});",
          "",
        ].join("\n"),
        "agent/connections/linear.ts": [
          'import { connect } from "@vercel/connect/eve";',
          'import { defineMcpClientConnection } from "eve/connections";',
          "",
          "export default defineMcpClientConnection({",
          "  auth: connect({",
          '    connector: "linear/manifest-test",',
          '    service: "linear",',
          "  }),",
          '  description: "Linear issues and projects.",',
          '  url: "https://mcp.linear.app/mcp",',
          "});",
          "",
        ].join("\n"),
        "agent/instructions.md": "Help with Slack and Linear.\n",
      },
      installDependencies: true,
      name: "connect-manifest-build",
    });

    await runPnpmCommand({
      args: ["exec", "eve", "build", "--skip-sandbox-prewarm"],
      cwd: app.appRoot,
    });

    const manifest = JSON.parse(
      await readFile(join(app.appRoot, ".output", "vercel-connect-manifest.json"), "utf8"),
    ) as { requirements: unknown[] };

    expect(manifest).toMatchObject({
      generator: { name: "eve" },
      kind: "vercel-connect-manifest",
      requirements: [
        {
          connect: { service: "linear", subjectTypes: ["user"] },
          interfaces: [{ protocol: "mcp", url: "https://mcp.linear.app/mcp" }],
          target: "connector:linear/manifest-test",
          triggers: [],
          uses: [{ kind: "connection", logicalPath: "connections/linear.ts", name: "linear" }],
        },
        {
          connect: {
            manifest: {
              $type: "https://docs.slack.dev/reference/app-manifest/",
              display_information: { name: "slack" },
              features: { bot_user: { display_name: "slack" } },
              oauth_config: {
                scopes: { bot: expect.arrayContaining(["app_mentions:read", "chat:write"]) },
              },
              settings: {
                event_subscriptions: { bot_events: ["app_mention"] },
              },
            },
            service: "slack",
            subjectTypes: ["app"],
            type: "slack",
          },
          interfaces: [],
          target: "connector:slack/manifest-test",
          triggers: [{ path: "/eve/v1/slack" }],
          uses: [{ kind: "channel", logicalPath: "channels/slack.ts", name: "slack" }],
        },
      ],
      schemaVersion: 1,
    });
  });

  it("returns compiler JSON", async () => {
    const appRoot = await createAppWithCompiler(
      "export function experimental_createConnectManifestFromEveResources() { return { ok: true }; }\n",
    );

    await expect(createConnectManifest({ appRoot, snapshot })).resolves.toEqual({ ok: true });
  });

  it("surfaces compiler failures with recovery guidance", async () => {
    const appRoot = await createAppWithCompiler(
      'export function experimental_createConnectManifestFromEveResources() { throw new Error("unsupported snapshot"); }\n',
    );

    await expect(createConnectManifest({ appRoot, snapshot })).rejects.toThrow(
      "Failed to create the Connect manifest: unsupported snapshot. Update @vercel/connect and rerun `eve build`.",
    );
  });

  it("rejects a package without the compiler export", async () => {
    const appRoot = await createAppWithCompiler("export {};\n");

    await expect(createConnectManifest({ appRoot, snapshot })).rejects.toThrow(
      /missing experimental_createConnectManifestFromEveResources export/,
    );
  });

  it("skips compiler resolution when there are no resources", async () => {
    const empty = createExternalResourcesSnapshot({ generatorVersion: "1.2.3", resources: [] });

    await expect(
      createConnectManifest({ appRoot: "/missing", snapshot: empty }),
    ).resolves.toBeUndefined();
  });
});
