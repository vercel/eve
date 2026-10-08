import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  headlessAsker,
  InteractionRequired,
  InvalidAnswerError,
  withAnswers,
  withPolicy,
} from "#setup/ask.js";
import type { SlackConnectorSlug } from "#setup/scaffold/index.js";
import type { SlackConnectorCandidate } from "#setup/slackbot.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applySlackSetup, prepareSlackSetup, type SlackSetupDeps } from "./setup.js";

function channelResult(action: "created" | "skipped" = "created") {
  return action === "skipped"
    ? {
        kind: "slack" as const,
        action,
        filesWritten: [] as [],
        filesSkipped: ["/project/agent/channels/slack.ts"] as [string],
        packageJsonUpdated: [] as [],
      }
    : {
        kind: "slack" as const,
        action,
        filesWritten: [],
        filesOverwritten: [],
        filesSkipped: [],
        packageJsonUpdated: [],
        slackConnectorSlug: "agent" as SlackConnectorSlug,
      };
}

function candidate(uid: string, overrides: Partial<SlackConnectorCandidate> = {}) {
  return {
    uid,
    id: `scl_${uid.slice("slack/".length)}`,
    attached: true,
    destination: "correct" as const,
    triggerDestinations: [],
    otherProjects: [],
    createdAt: 1,
    workspace: { workspaceUrl: "https://slack.com/app_redirect?app=A0&team=T0" },
    ...overrides,
  };
}

function deps(): SlackSetupDeps {
  return {
    deriveSlackConnectorSlug: vi.fn(async () => "agent" as SlackConnectorSlug),
    ensureChannel: vi.fn(async () => channelResult()),
    inspectConnectors: vi.fn(async () => ({ candidates: [], inUse: [] })),
    provisionSlackbot: vi.fn(async () => ({
      state: "attached" as const,
      connectorUid: "slack/agent",
    })),
    reconcileSlackUid: vi.fn(async () => true),
    readSlackChannelFile: vi.fn(async () => ({ kind: "absent" as const })),
    missingSlackEnvironment: vi.fn(async () => []),
  };
}

function contexts(
  answers: Record<string, unknown>,
  assume = false,
  auth: "authenticated" | "logged-out" = "authenticated",
) {
  const base = headlessAsker();
  const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
  const fake = createFakePrompter();
  return {
    ...createSetupContexts({
      appRoot: "/project",
      asker: withAnswers(answers)(assume ? withPolicy("assume")(base) : base),
      environment: integrationSetupEnvironment(auth, { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject,
    }),
    log: fake.prompter.log,
    resolveVercelProject,
  };
}

async function selectedConnector(effects: SlackSetupDeps) {
  const options = vi.mocked(effects.provisionSlackbot).mock.calls[0]?.[4];
  return options?.selectConnector?.([], undefined);
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
  it("passes Vercel's create error through and explains an unconfirmed browser request", async () => {
    const effects = deps();
    const ctx = contexts({}, true);
    const plan = await prepareSlackSetup(ctx.prepare, effects);
    vi.mocked(effects.provisionSlackbot).mockResolvedValueOnce({
      state: "create-failed",
      detail: "Error: Connect is not available for this team.",
    });
    await expect(applySlackSetup(plan, ctx.apply, effects)).rejects.toThrow(
      "Vercel could not create the Slack connector: Error: Connect is not available for this team. Slack channel was not added. Fix the problem Vercel reported, then re-run `eve add channel/slack`.",
    );
    vi.mocked(effects.provisionSlackbot).mockResolvedValueOnce({
      state: "cleanup-failed",
      connectorUids: [],
    });
    await expect(applySlackSetup(plan, ctx.apply, effects)).rejects.toThrow(
      "eve couldn't confirm that the Slack setup in your browser ended. Slack channel was not added. Close the Slack setup page in your browser",
    );
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
  it("offers team connectors and resolves the choice during prepare", async () => {
    const connector = candidate("slack/existing");
    const effects = deps();
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      inUse: [],
      candidates: [connector],
      preferred: connector,
    });
    const ctx = contexts({ "slack-credentials": "vercel", "slack-connector": connector.uid });
    const plan = await prepareSlackSetup(ctx.prepare, effects);
    await applySlackSetup(plan, ctx.apply, effects);
    expect(await selectedConnector(effects)).toBe(connector);
  });
  it("names the searched team when the connector answer is unknown", async () => {
    const effects = deps();
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      inUse: [],
      candidates: [candidate("slack/existing")],
    });
    const ctx = contexts({ "slack-credentials": "vercel", "slack-connector": "slack/missing" });

    const error = await prepareSlackSetup(ctx.prepare, effects).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidAnswerError);
    expect((error as InvalidAnswerError).message).toContain(
      "Searched Slack connectors in team team.",
    );
  });
  it("explains which connectors setup reuses when the answer isn't one", async () => {
    const effects = deps();
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      candidates: [candidate("slack/agent")],
      inUse: [],
    });
    const ctx = contexts({ "slack-credentials": "vercel", "slack-connector": "slack/elsewhere" });

    await expect(prepareSlackSetup(ctx.prepare, effects)).rejects.toThrow(
      "eve reuses a Slack app only when it is attached to this project, or named slack/agent and unused by other projects.",
    );
  });
  it("stops when the channel file names a connector another project uses", async () => {
    const shared = candidate("slack/shared", {
      attached: false,
      otherProjects: [{ id: "prj_prod", name: "chief-prod" }],
    });
    const effects = deps();
    vi.mocked(effects.readSlackChannelFile).mockResolvedValue({
      kind: "connect",
      connectorUid: shared.uid,
    });
    vi.mocked(effects.inspectConnectors).mockResolvedValue({ candidates: [], inUse: [shared] });

    await expect(prepareSlackSetup(contexts({}).prepare, effects)).rejects.toThrow(
      "`slack/shared` is used by chief-prod.",
    );
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
  });
  it("resumes from a channel file's connector without asking anything", async () => {
    const named = candidate("slack/named");
    const effects = deps();
    vi.mocked(effects.readSlackChannelFile).mockResolvedValue({
      kind: "connect",
      connectorUid: named.uid,
    });
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      inUse: [],
      candidates: [candidate("slack/agent"), named],
      preferred: named,
    });
    vi.mocked(effects.ensureChannel).mockResolvedValue(channelResult("skipped"));
    vi.mocked(effects.provisionSlackbot).mockResolvedValue({
      state: "already-configured",
      connectorUid: named.uid,
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
    });
    const ctx = contexts({});

    const plan = await prepareSlackSetup(ctx.prepare, effects);
    const completion = await applySlackSetup(plan, ctx.apply, effects);

    expect(await selectedConnector(effects)).toBe(named);
    expect(vi.mocked(effects.provisionSlackbot).mock.calls[0]?.[4]).toMatchObject({
      channelConnectorUid: named.uid,
    });
    expect(effects.reconcileSlackUid).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ connectorUid: named.uid }),
      named.uid,
    );
    expect(completion.facts).toEqual([
      expect.objectContaining({ label: "Agent Slack DM", kind: "url" }),
    ]);
    expect(ctx.log.success).toHaveBeenCalledWith("Slack is already set up with slack/named.");
  });
  it("offers selection when the channel file's connector is not in the team", async () => {
    const replacement = candidate("slack/agent");
    const effects = deps();
    vi.mocked(effects.readSlackChannelFile).mockResolvedValue({
      kind: "connect",
      connectorUid: "slack/gone",
    });
    vi.mocked(effects.inspectConnectors).mockResolvedValue({
      inUse: [],
      candidates: [replacement],
      preferred: replacement,
    });
    vi.mocked(effects.ensureChannel).mockResolvedValue(channelResult("skipped"));
    const ctx = contexts({ "slack-connector": replacement.uid });

    const plan = await prepareSlackSetup(ctx.prepare, effects);
    await applySlackSetup(plan, ctx.apply, effects);

    expect(ctx.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("`slack/gone`, which was not found in team team"),
    );
    expect(await selectedConnector(effects)).toBe(replacement);
    // The file still names the missing UID, so apply patches it.
    expect(vi.mocked(effects.reconcileSlackUid).mock.calls[0]?.[3]).toBe("slack/gone");
  });
  it("leaves a portable-credential channel file alone and reports missing variables", async () => {
    const effects = deps();
    vi.mocked(effects.readSlackChannelFile).mockResolvedValue({ kind: "environment" });
    vi.mocked(effects.missingSlackEnvironment).mockResolvedValue(["SLACK_SIGNING_SECRET"]);
    const ctx = contexts({});

    const plan = await prepareSlackSetup(ctx.prepare, effects);
    await expect(applySlackSetup(plan, ctx.apply, effects)).resolves.toEqual({ facts: [] });

    expect(ctx.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_SIGNING_SECRET is not set"),
    );
    expect(effects.ensureChannel).not.toHaveBeenCalled();
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
    expect(ctx.resolveVercelProject).not.toHaveBeenCalled();
  });
  it("allows the project resolver to authenticate and link Vercel Connect", async () => {
    const effects = deps();
    const ctx = contexts({ "slack-credentials": "vercel" }, false, "logged-out");

    await expect(prepareSlackSetup(ctx.prepare, effects)).resolves.toMatchObject({
      credentials: "vercel-connect",
      project: { orgId: "team", projectId: "project" },
    });
    expect(ctx.resolveVercelProject).toHaveBeenCalledWith("Slack");
  });
});
