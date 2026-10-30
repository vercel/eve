import { expect, it, vi } from "vitest";
import { createAgentSourceManifest } from "#discover/manifest.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { defineAgent } from "#public/definitions/agent.js";
import { githubChannel } from "#public/channels/github/index.js";
import { linearChannel } from "#public/channels/linear/index.js";
import { discordChannel } from "#public/channels/discord/index.js";
import { teamsChannel } from "#public/channels/teams/index.js";
import { linqChannel } from "#public/channels/linq/index.js";
import { photonIMessageChannel } from "#public/channels/photon/index.js";
import { slackChannel } from "#public/channels/slack/index.js";
import { buildExternalResourcesSnapshot } from "#internal/external-resources.js";

it("preserves Connect dependencies through channel compilation without resolving credentials", async () => {
  const token = vi.fn(async () => "runtime-only");
  const metadata = (service: string) => ({
    connector: `${service}/agent`,
    requirement: {
      reference: `connector:${service}/agent`,
      service,
      subjectTypes: ["app" as const],
      method: service,
    },
  });
  const credentials = <T extends object>(service: string, value: T) =>
    Object.assign(value, { vercelConnect: metadata(service) });
  const channels = [
    ["slack", slackChannel({ credentials: credentials("slack", { botToken: token }) })],
    [
      "github",
      githubChannel({
        credentials: credentials("github", { installationToken: token }),
      }),
    ],
    [
      "linear",
      linearChannel({
        credentials: credentials("linear", { accessToken: token }),
      }),
    ],
    [
      "discord",
      discordChannel({
        credentials: credentials("discord", { botToken: token }),
      }),
    ],
    [
      "teams",
      teamsChannel({
        credentials: credentials("microsoft-teams", {
          appId: "app",
          tokenProvider: async () => ({ accessToken: await token() }),
        }),
      }),
    ],
    ["linq", linqChannel({ credentials: credentials("linq", { apiKey: token }) })],
    [
      "photon",
      photonIMessageChannel({
        credentials: Object.assign(
          async () => ({ projectId: "project", projectSecret: await token() }),
          { vercelConnect: metadata("photon") },
        ),
      }),
    ],
    ["unmanaged", githubChannel({ credentials: { installationToken: token } })],
  ] as const;
  const compiled = await compileAgentManifest(
    createAgentSourceManifest({
      agentId: "coverage",
      appRoot: "/virtual/coverage",
      agentRoot: "/virtual/coverage/agent",
    }),
    {
      sourceRegistries: [
        createAgentSourceRegistry([
          {
            applyTo: "root",
            source: defineProgrammaticAgentSource({
              id: "test:channels",
              revision: "v1",
              modules: [
                {
                  logicalPath: "agent.ts",
                  loadNamespace: async () => ({
                    default: defineAgent({ model: "openai/gpt-5.4" }),
                  }),
                },
                ...channels.map(([name, channel]) => ({
                  logicalPath: `channels/${name}.ts`,
                  loadNamespace: async () => ({ default: { ...channel } }),
                })),
              ],
            }),
          },
        ]),
      ],
    },
  );
  const snapshot = buildExternalResourcesSnapshot({
    generatorVersion: "test",
    manifest: compiled,
    publicRoutePrefix: "/app",
  });
  expect(snapshot.resources.map(({ name }) => name).sort()).toEqual([
    "discord",
    "github",
    "linear",
    "linq",
    "photon",
    "slack",
    "teams",
  ]);
  expect(snapshot.resources.find(({ name }) => name === "slack")).toMatchObject({
    credentials: metadata("slack").requirement,
    manifest: { $type: "https://docs.slack.dev/reference/app-manifest/" },
    route: { path: "/app/eve/v1/slack" },
  });
  for (const [name, service] of [
    ["github", "github"],
    ["linear", "linear"],
    ["discord", "discord"],
    ["teams", "microsoft-teams"],
    ["linq", "linq"],
    ["photon", "photon"],
  ] as const) {
    expect(snapshot.resources).toContainEqual({
      kind: "channel",
      name,
      logicalPath: `channels/${name}.ts`,
      credentials: metadata(service).requirement,
      route: { path: `/app/eve/v1/${name}` },
    });
  }
  expect(token).not.toHaveBeenCalled();
});
