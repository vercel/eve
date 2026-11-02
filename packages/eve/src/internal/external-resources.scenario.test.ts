import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";

describe("Connect manifest build output", () => {
  const scenarioApp = useScenarioApp();

  it("emits declared requirements during a real build without the Connect SDK", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          'import { defineAgent } from "eve";',
          "",
          'export default defineAgent({ model: "openai/gpt-5-mini" });',
          "",
        ].join("\n"),
        "agent/channels/slack.ts": [
          'import { slackChannel } from "eve/channels/slack";',
          "",
          "export default slackChannel({",
          "  credentials: {",
          '    botToken: async () => { throw new Error("Build must not fetch credentials"); },',
          '    vercelConnect: { connector: "slack/manifest-test", requirement: {',
          '      reference: "connector:slack/manifest-test", service: "slack", method: "slack", subjectTypes: ["app"],',
          "    } },",
          "  },",
          "});",
          "",
        ].join("\n"),
        "agent/connections/linear.ts": [
          'import { defineMcpClientConnection } from "eve/connections";',
          "",
          "export default defineMcpClientConnection({",
          "  auth: {",
          '    getToken: async () => { throw new Error("Build must not fetch credentials"); },',
          '    vercelConnect: { connector: "linear/manifest-test", requirement: {',
          '      reference: "connector:linear/manifest-test", service: "linear", subjectTypes: ["user"],',
          "    } },",
          "  },",
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
});
