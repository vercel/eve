import { expect, it, vi } from "vitest";
import type { Adapter } from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import { chatSdkChannel } from "#public/channels/chat-sdk/index.js";
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
import { telegramChannel } from "#public/channels/telegram/index.js";
import { twilioChannel } from "#public/channels/twilio/index.js";
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
    ["telegram", telegramChannel({ credentials: credentials("telegram", { botToken: token }) })],
    [
      "twilio",
      twilioChannel({
        allowFrom: ["+15550000001"],
        credentials: credentials("twilio", { accountSid: "AC123", authToken: token }),
      }),
    ],
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
  const compiled = await compileChannels(channels);
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
    "telegram",
    "twilio",
    "twilio",
    "twilio",
  ]);
  expect(
    snapshot.resources
      .filter(({ name }) => name === "twilio")
      .map((resource) => (resource.kind === "channel" ? resource.route.path : null))
      .sort(),
  ).toEqual([
    "/app/eve/v1/twilio/messages",
    "/app/eve/v1/twilio/voice",
    "/app/eve/v1/twilio/voice/transcription",
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

async function compileChannels(channels: readonly (readonly [string, object])[]) {
  return compileAgentManifest(
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
}

function chatConfig() {
  const initialize = vi.fn(() => {
    throw new Error("build must not initialize adapters");
  });
  // Build declarations do not need runtime adapter operations.
  const adapter = (name: string) => ({ name, initialize }) as unknown as Adapter;
  return {
    userName: "test",
    adapters: {
      slack: adapter("slack"),
      discord: adapter("discord"),
      unmanaged: adapter("unmanaged"),
    },
    state: createMemoryState(),
    initialize,
  };
}

it.each([false, true])(
  "keeps each Chat SDK requirement on its own compiled route (wrapped: %s)",
  async (wrap) => {
    const { initialize, ...config } = chatConfig();
    const { channel } = chatSdkChannel({
      ...config,
      route: "/webhooks",
      routes: { discord: "/hooks/community" },
      connect: {
        slack: { connector: "slack/support", service: "slack", type: "slack" },
        discord: {
          connector: "discord/community",
          service: "discord",
          subjectTypes: ["app", "user"],
        },
      },
    });
    const compiled = await compileChannels([
      [
        "chat",
        {
          ...channel,
          routes: channel.routes.map((route) => ({
            ...route,
            path: wrap ? `/wrapped${route.path}` : route.path,
          })),
        },
      ],
    ]);
    const snapshot = buildExternalResourcesSnapshot({
      generatorVersion: "test",
      manifest: compiled,
      publicRoutePrefix: "/app",
    });
    expect(snapshot.resources).toEqual([
      {
        kind: "channel",
        name: "chat",
        logicalPath: "channels/chat.ts",
        credentials: {
          reference: "connector:slack/support",
          service: "slack",
          method: "slack",
          subjectTypes: ["app"],
        },
        route: { path: `/app${wrap ? "/wrapped" : ""}/webhooks/slack` },
      },
      {
        kind: "channel",
        name: "chat",
        logicalPath: "channels/chat.ts",
        credentials: {
          reference: "connector:discord/community",
          service: "discord",
          subjectTypes: ["app", "user"],
        },
        route: { path: `/app${wrap ? "/wrapped" : ""}/hooks/community` },
      },
    ]);
    expect(initialize).not.toHaveBeenCalled();
  },
);

it("rejects a declared and undeclared Chat SDK adapter sharing one route", () => {
  const { initialize: _, ...config } = chatConfig();
  expect(() =>
    chatSdkChannel({
      ...config,
      routes: { slack: "/shared", unmanaged: "/shared" },
      connect: { slack: { connector: "slack/support", service: "slack" } },
    }),
  ).toThrow('Multiple Chat SDK adapters use the route "/shared"');
});

it.each([
  [{ missing: { connector: "slack/support", service: "slack" } }, "unknown Chat SDK adapter"],
  [{ slack: { connector: "", service: "slack" } }, "Invalid Connect requirement"],
  [
    { slack: { connector: "slack/support", service: "slack", subjectTypes: [] } },
    "Invalid Connect requirement",
  ],
  [{ slack: null }, "Invalid Connect requirement"],
])("rejects invalid Chat SDK Connect declarations %j", (connect, message) => {
  const { initialize: _, ...config } = chatConfig();
  // Model JavaScript callers which do not have TypeScript's config checks.
  expect(() => chatSdkChannel({ ...config, connect: connect as never })).toThrow(message);
});

it.each([false, 1, "slack", null, [], new Map()])(
  "rejects invalid Chat SDK connect containers %j",
  (connect) => {
    const { initialize: _, ...config } = chatConfig();
    expect(() => chatSdkChannel({ ...config, connect: connect as never })).toThrow(
      "connect declarations must be a plain object",
    );
  },
);
