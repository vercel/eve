import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyDiscordSetup, prepareDiscordSetup, type DiscordSetupDeps } from "./setup.js";

const COMMAND_ANSWERS = {
  "discord-messages": "commands",
  "discord-bot-token": " bot-token ",
  "discord-command-name": "ask",
  "discord-command-description": "Ask the eve agent",
};
// Answering messages asks no command questions, so none are supplied.
const GATEWAY_ANSWERS = {
  "discord-messages": "gateway",
  "discord-bot-token": " bot-token ",
};
function deps(
  files: Record<string, string> = { "/project/vercel.json": '{ "framework": "eve" }' },
  messageContentAllowed = true,
) {
  const effects: DiscordSetupDeps = {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    enableMessageContent: vi.fn(async () => messageContentAllowed),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "discord/agent" })),
    readTextFile: vi.fn(async (path: string) => files[path]),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({ id: "app", name: "Agent", publicKey: "key" })),
    writeTextFile: vi.fn(async () => {}),
  };
  const written = () =>
    new Map(vi.mocked(effects.writeTextFile).mock.calls.map(([path, content]) => [path, content]));
  return { effects, written };
}
function contexts(
  answers: Record<string, unknown>,
  resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  auth: Parameters<typeof integrationSetupEnvironment>[0] = "authenticated",
) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment(auth, { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject,
  });
}
async function runSetup(answers: Record<string, unknown>, effects: DiscordSetupDeps) {
  const ctx = contexts(answers);
  return await applyDiscordSetup(
    await prepareDiscordSetup(ctx.prepare, effects),
    ctx.apply,
    effects,
  );
}
const installUrl = (permissions: string) =>
  `https://discord.com/oauth2/authorize?client_id=app&scope=bot%20applications.commands&permissions=${permissions}`;

describe("Discord setup", () => {
  it("registers a slash command without the relay when people use a command", async () => {
    const { effects, written } = deps();
    const ctx = contexts(COMMAND_ANSWERS);
    const plan = await prepareDiscordSetup(ctx.prepare, effects);
    expect(effects.resolveApplication).not.toHaveBeenCalled();
    const completion = await applyDiscordSetup(plan, ctx.apply, effects);

    expect(effects.resolveApplication).toHaveBeenCalledWith("bot-token");
    expect(effects.registerCommand).toHaveBeenCalledWith("app", "bot-token", {
      description: "Ask the eve agent",
      name: "ask",
    });
    expect([...written().keys()]).toEqual(["/project/agent/channels/discord.ts"]);
    expect(written().get("/project/agent/channels/discord.ts")).not.toContain("gateway");
    expect(completion.facts).toContainEqual({
      kind: "url",
      label: "Discord bot install URL",
      value: installUrl("3072"),
    });
  });

  it("scaffolds the Gateway relay and skips the slash command when people message the bot", async () => {
    const { effects, written } = deps();

    const completion = await runSetup(GATEWAY_ANSWERS, effects);

    expect(effects.registerCommand).not.toHaveBeenCalled();
    expect(effects.configureEndpoint).toHaveBeenCalledWith("bot-token", "connector");
    expect(written().get("/project/agent/channels/discord.ts")).toContain("gateway: {},");
    expect(written().get("/project/daemon/main.ts")).toContain(
      'experimental_runDiscordGatewayRelay({\n  credentials: connectDiscordCredentials("discord/agent")',
    );
    // Setup turned the intent on, so thread follow-ups work without a mention.
    expect(effects.enableMessageContent).toHaveBeenCalledWith("bot-token");
    expect(written().get("/project/daemon/main.ts")).toContain("messageContent: true,");
    expect([...written().keys()]).toEqual(
      expect.arrayContaining([
        "/project/daemon/Dockerfile",
        "/project/daemon/package.json",
        "/project/daemon/.dockerignore",
      ]),
    );
    expect(JSON.parse(written().get("/project/vercel.json")!)).toEqual({
      daemons: {
        "discord-gateway": { entrypoint: "Dockerfile", instances: { iad1: 1 }, root: "daemon" },
      },
      framework: "eve",
    });
    // View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads.
    expect(completion.facts).toContainEqual({
      kind: "url",
      label: "Discord bot install URL",
      value: installUrl(String(1024 + 2048 + 65536 + 2 ** 35 + 2 ** 38)),
    });
  });

  it("scaffolds the relay without Message Content and says how to fix it when Discord refuses", async () => {
    const { effects, written } = deps(undefined, false);

    const completion = await runSetup(GATEWAY_ANSWERS, effects);

    expect(written().get("/project/daemon/main.ts")).toContain("messageContent: false,");
    expect(completion.facts).toContainEqual({
      label: "Enable Message Content",
      value: expect.stringContaining("Discord Developer Portal"),
    });
  });

  it("leaves vercel.ts alone and reports the daemon entry to add", async () => {
    const { effects, written } = deps({ "/project/vercel.ts": "export default withEve({});" });

    const completion = await runSetup(GATEWAY_ANSWERS, effects);

    expect(written().has("/project/vercel.json")).toBe(false);
    expect(written().has("/project/vercel.ts")).toBe(false);
    expect(completion.facts).toContainEqual({
      label: "Add to the config vercel.ts exports",
      value: expect.stringContaining('"discord-gateway"'),
    });
  });

  it("refuses an existing relay file before provisioning anything", async () => {
    const { effects } = deps({ "/project/daemon/main.ts": "// authored" });
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));

    await expect(
      prepareDiscordSetup(contexts(GATEWAY_ANSWERS, resolveVercelProject).prepare, effects),
    ).rejects.toThrow("/project/daemon/main.ts");
    expect(resolveVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("refuses missing input before mutation", async () => {
    const { effects } = deps();
    await expect(
      prepareDiscordSetup(contexts({ "discord-messages": "gateway" }).prepare, effects),
    ).rejects.toMatchObject({
      prerequisite: { kind: "environment", variable: "DISCORD_BOT_TOKEN" },
    });
    expect(effects.resolveApplication).not.toHaveBeenCalled();
  });
  it("requires a linked project", async () => {
    const { effects } = deps();
    const resolveVercelProject = vi.fn(async () => {
      throw new Error("eve link");
    });
    await expect(
      prepareDiscordSetup(contexts(COMMAND_ANSWERS, resolveVercelProject).prepare, effects),
    ).rejects.toThrow("eve link");
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });
  it("routes logged-out setup through the project resolver", async () => {
    const { effects } = deps();
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));

    await expect(
      prepareDiscordSetup(
        contexts(COMMAND_ANSWERS, resolveVercelProject, "logged-out").prepare,
        effects,
      ),
    ).resolves.toMatchObject({ project: { orgId: "team", projectId: "project" } });
    expect(resolveVercelProject).toHaveBeenCalledWith("Discord");
  });
});
