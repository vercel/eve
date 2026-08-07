import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers, withPolicy } from "#setup/ask.js";
import type { SlackConnectorSlug } from "#setup/scaffold/index.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applySlackSetup, prepareSlackSetup, type SlackSetupDeps } from "./setup.js";

function channelResult() {
  return {
    kind: "slack" as const,
    action: "created" as const,
    filesWritten: [],
    filesOverwritten: [],
    filesSkipped: [],
    packageJsonUpdated: [],
    slackConnectorSlug: "agent" as SlackConnectorSlug,
  };
}
function deps(): SlackSetupDeps {
  return {
    deriveSlackConnectorSlug: vi.fn(async () => "agent" as SlackConnectorSlug),
    ensureChannel: vi.fn(async () => channelResult()),
    inspectConnectors: vi.fn(async () => ({
      state: "not-found" as const,
      connectorUids: new Set<string>(),
    })),
    provisionSlackbot: vi.fn(async () => ({
      state: "attached" as const,
      connectorUid: "slack/agent",
    })),
    reconcileSlackUid: vi.fn(async () => true),
  };
}
function contexts(answers: Record<string, unknown>, assume = false) {
  const base = headlessAsker();
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(assume ? withPolicy("assume")(base) : base),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

describe("Slack setup", () => {
  it("accepts recommendations before apply", async () => {
    const effects = deps();
    const ctx = contexts({}, true);
    const plan = await prepareSlackSetup(ctx.prepare, effects);
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
    await applySlackSetup(plan, ctx.apply, effects);
    expect(effects.provisionSlackbot).toHaveBeenCalledOnce();
  });
  it("scaffolds portable credentials without provisioning", async () => {
    const effects = deps();
    const ctx = contexts({ "slack-credentials": "portable" });
    const plan = await prepareSlackSetup(ctx.prepare, effects);
    await applySlackSetup(plan, ctx.apply, effects);
    expect(effects.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ slackCredentials: "environment" }),
    );
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
  });
  it("refuses missing credentials before discovery", async () => {
    const effects = deps();
    await expect(prepareSlackSetup(contexts({}).prepare, effects)).rejects.toBeInstanceOf(
      InteractionRequired,
    );
    expect(effects.deriveSlackConnectorSlug).not.toHaveBeenCalled();
  });
  it("resolves connector choice during prepare", async () => {
    const connector = { id: "existing", uid: "slack/existing" };
    const effects = deps();
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      state: "found",
      connectors: [connector],
      preferred: connector,
      connectorUids: new Set([connector.uid]),
    });
    const ctx = contexts({ "slack-credentials": "vercel", "slack-connector": connector.uid });
    const plan = await prepareSlackSetup(ctx.prepare, effects);
    await applySlackSetup(plan, ctx.apply, effects);
    const options = vi.mocked(effects.provisionSlackbot).mock.calls[0]?.[4];
    expect(await options?.selectConnector?.([], undefined)).toBe(connector);
  });
});
