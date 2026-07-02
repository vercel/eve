import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { AddChannelsDeps } from "#setup/boxes/add-channels.js";
import { CHANNELS_PROMPT_MESSAGE } from "#setup/boxes/select-channels.js";
import type { ExistingChannelRegistrations } from "#setup/channel-add-conflicts.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import type { PrompterValue, SelectOption, SingleSelectOptions } from "#setup/prompter.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { WizardCancelledError } from "#setup/step.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";

import { runChannelsFlow, SEE_IT_LIVE_MESSAGE } from "./channels.js";

// The flow probes Vercel auth at startup; default it to authenticated so the
// existing cases never spawn a real `vercel whoami`. The auth-aware row tests
// inject `getVercelAuthStatus` explicitly to override this.
vi.mock("../vercel-project.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vercel-project.js")>()),
  getVercelAuthStatus: vi.fn(async () => "authenticated"),
}));

const APP_ROOT = "/app/my-agent";
const UNLINKED: DeploymentInfo = { state: "unlinked" };
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };

const NO_REGISTRATIONS: ExistingChannelRegistrations = {
  disabledChannelReasons: {},
  webRouteOwners: [],
  slackOwners: [],
  webAppPresent: false,
};

/** An Esc on the channel list, in a scripted pick sequence. */
const CANCEL = Symbol("cancel");

/**
 * Scripts the action-list loop: each list paint consumes the next pick (and
 * records the painted rows), while every other single-select goes to `rest`.
 */
function scriptList(
  picks: ReadonlyArray<PrompterValue | typeof CANCEL>,
  rest?: (opts: SingleSelectOptions<PrompterValue>) => PrompterValue,
) {
  const queue = [...picks];
  const listPaints: SelectOption<PrompterValue>[][] = [];
  const single = (opts: SingleSelectOptions<PrompterValue>): PrompterValue => {
    if (opts.message !== CHANNELS_PROMPT_MESSAGE) {
      if (rest !== undefined) return rest(opts);
      throw new Error(`Unexpected select: ${opts.message}`);
    }
    listPaints.push(opts.options);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("The channel list was asked more times than the test scripted.");
    }
    if (next === CANCEL) throw new WizardCancelledError();
    return next;
  };
  return { single, listPaints };
}

function createAddChannelsDeps() {
  return {
    ensureChannel: vi.fn<AddChannelsDeps["ensureChannel"]>(async (options) =>
      options.kind === "web"
        ? {
            kind: "web",
            action: "created",
            filesWritten: [join(options.projectRoot, "app/page.tsx")],
            filesSkipped: [],
            packageJsonUpdated: [],
          }
        : {
            kind: "slack",
            action: "created",
            filesWritten: [join(options.projectRoot, "agent/channels/slack.ts")],
            filesSkipped: [],
            packageJsonUpdated: [],
            slackConnectorSlug:
              options.slackConnectorSlug ?? (await deriveSlackConnectorSlug(options.projectRoot)),
          },
    ),
    deriveSlackConnectorSlug,
    provisionSlackbot: vi.fn<AddChannelsDeps["provisionSlackbot"]>(async () => ({
      state: "attached",
      connectorUid: "slack/my-agent",
    })),
    reconcileSlackUid: vi.fn<AddChannelsDeps["reconcileSlackUid"]>(async () => true),
    detectPackageManager: vi.fn<AddChannelsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<AddChannelsDeps["runPackageManagerInstall"]>(async () => true),
    runVercel: vi.fn<AddChannelsDeps["runVercel"]>(async () => true),
    detectDeployment: vi.fn<AddChannelsDeps["detectDeployment"]>(async () => UNLINKED),
  };
}

describe("runChannelsFlow", () => {
  it("adds the picked channel, repaints it as a checked task, and Done exits", async () => {
    const inspect = vi
      .fn(async () => NO_REGISTRATIONS)
      .mockResolvedValueOnce(NO_REGISTRATIONS)
      .mockResolvedValueOnce({ ...NO_REGISTRATIONS, webAppPresent: true });
    const { single, listPaints } = scriptList(["web", "done"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: inspect,
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: ["web"] });
    expect(addChannelsDeps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", projectRoot: APP_ROOT }),
    );
    // The list repaints from a fresh inspection: the added channel is checked.
    expect(listPaints).toHaveLength(2);
    const webRow = listPaints[1]?.find((option) => option.value === "web");
    expect(webRow).toMatchObject({
      completed: true,
      focusHint: "Already installed",
      label: "Web Chat",
    });
    expect(webRow?.hint).toBeUndefined();
  });

  it("offers a Done row and exits with no additions", async () => {
    const { single, listPaints } = scriptList(["done"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
    expect(listPaints[0]?.at(-1)).toMatchObject({ value: "done", trailingAction: true });
  });

  it("defaults the cursor to Done when every channel is already added or unavailable", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const fake = createFakePrompter({
      single: (opts) => {
        captured = opts;
        return "done";
      },
    });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => ({
          ...NO_REGISTRATIONS,
          webAppPresent: true,
          slackOwners: ["agent/channels/slack.ts"],
        })),
        addChannels: createAddChannelsDeps(),
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    expect(captured?.initialValue).toBe("done");
  });

  it("leaves the cursor default alone while a channel is still addable", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const fake = createFakePrompter({
      single: (opts) => {
        captured = opts;
        return "done";
      },
    });

    await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        // Web Chat is still addable, so the cursor keeps its first-focusable default.
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: createAddChannelsDeps(),
      },
    });

    expect(captured?.initialValue).toBeUndefined();
  });

  it("disables kinds that are already registered by authored channels", async () => {
    const { single, listPaints } = scriptList(["done"]);
    const fake = createFakePrompter({ single });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => ({
          ...NO_REGISTRATIONS,
          disabledChannelReasons: { slack: "already configured" },
        })),
        addChannels: createAddChannelsDeps(),
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    const slackRow = listPaints[0]?.find((option) => option.value === "slack");
    expect(slackRow).toMatchObject({ disabled: true, disabledReason: "already configured" });
  });

  /** Drives the channel list once and returns the Slack row from the first paint. */
  async function slackRowFor(input: {
    deployment: DeploymentInfo;
    authStatus: VercelAuthStatus;
  }): Promise<SelectOption<PrompterValue> | undefined> {
    const { single, listPaints } = scriptList(["done"]);
    const fake = createFakePrompter({ single });
    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => input.deployment),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        getVercelAuthStatus: vi.fn(async () => input.authStatus),
        addChannels: createAddChannelsDeps(),
      },
    });
    expect(result).toEqual({ kind: "done", addedChannels: [] });
    return listPaints[0]?.find((option) => option.value === "slack");
  }

  it("points an unlinked Vercel-dependent channel at /model when logged in", async () => {
    expect(await slackRowFor({ deployment: UNLINKED, authStatus: "authenticated" })).toMatchObject({
      disabled: true,
      disabledReason: "Requires Vercel account, see /model",
      disabledReasonTone: "warning",
    });
  });

  it("points a Vercel-dependent channel at /vc:login when logged out, even if linked", async () => {
    // Authentication is a separate axis from link: a linked-but-logged-out
    // directory still cannot provision, so the row routes to /vc:login, not /model.
    for (const deployment of [UNLINKED, LINKED]) {
      expect(await slackRowFor({ deployment, authStatus: "logged-out" })).toMatchObject({
        disabled: true,
        disabledReason: "Log in to Vercel first, see /vc:login",
        disabledReasonTone: "warning",
      });
    }
  });

  it("points a Vercel-dependent channel at the CLI install when the CLI is missing", async () => {
    expect(await slackRowFor({ deployment: UNLINKED, authStatus: "cli-missing" })).toMatchObject({
      disabled: true,
      disabledReason: "Vercel CLI not found, see /vc:install",
      disabledReasonTone: "warning",
    });
  });

  it("flags a Vercel-dependent channel as unreachable on a transient fault", async () => {
    expect(await slackRowFor({ deployment: LINKED, authStatus: "unavailable" })).toMatchObject({
      disabled: true,
      disabledReason: "Couldn't reach Vercel, check your connection",
      disabledReasonTone: "warning",
    });
  });

  it("keeps a Vercel-dependent channel addable when authenticated and linked", async () => {
    const slackRow = await slackRowFor({ deployment: LINKED, authStatus: "authenticated" });
    expect(slackRow?.disabled).toBeUndefined();
  });

  it("shows the active Terminal UI as a checked task and keeps Web Chat addable", async () => {
    const { single, listPaints } = scriptList(["web", "done"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => ({
          ...NO_REGISTRATIONS,
          webRouteOwners: ["channels/eve.ts"],
        })),
        addChannels: addChannelsDeps,
      },
    });

    // The scaffolded eve.ts serves the REPL; it must not block the Next.js app.
    expect(result).toEqual({ kind: "done", addedChannels: ["web"] });
    expect(addChannelsDeps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web" }),
    );
    expect(listPaints[0]?.[0]).toMatchObject({
      value: "repl",
      label: "Terminal UI",
      completed: true,
      focusHint: "Already installed",
    });
    const webRow = listPaints[0]?.find((option) => option.value === "web");
    expect(webRow?.locked).toBeUndefined();
  });

  it("checks Web Chat when the Next.js app is already present", async () => {
    const { single, listPaints } = scriptList(["done"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => ({
          ...NO_REGISTRATIONS,
          webRouteOwners: ["channels/eve.ts"],
          webAppPresent: true,
        })),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
    const webRow = listPaints[0]?.find((option) => option.value === "web");
    expect(webRow).toMatchObject({
      completed: true,
      focusHint: "Already installed",
      label: "Web Chat",
    });
    expect(webRow?.hint).toBeUndefined();
  });

  it("defensively treats a completed value returned by a prompter as a no-op", async () => {
    const { single, listPaints } = scriptList(["repl", "web", "done"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => ({
          ...NO_REGISTRATIONS,
          webAppPresent: true,
        })),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
    expect(listPaints).toHaveLength(3);
  });

  it("folds an Esc with no additions to cancelled", async () => {
    const { single } = scriptList([CANCEL]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
  });

  it("reports additions on Esc exactly like Done — they already happened on disk", async () => {
    const { single } = scriptList(["web", CANCEL]);
    const fake = createFakePrompter({ single });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: createAddChannelsDeps(),
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: ["web"] });
  });

  it("returns to the list when a channel's sub-flow is cancelled", async () => {
    const { single, listPaints } = scriptList(["slack", "done"], (opts) => {
      if (/slackbot/i.test(opts.message)) throw new WizardCancelledError();
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(
          async () => ({ state: "linked", projectId: "prj_1", orgId: "org_1" }) as DeploymentInfo,
        ),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: [] });
    expect(addChannelsDeps.ensureChannel).not.toHaveBeenCalled();
    expect(listPaints).toHaveLength(2);
  });

  it("reports a channel whose files landed before cancellation", async () => {
    const controller = new AbortController();
    const { single } = scriptList(["web"]);
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();
    addChannelsDeps.ensureChannel.mockImplementation(async (options) => {
      controller.abort(new WizardCancelledError());
      return {
        kind: "web",
        action: "created",
        filesWritten: [join(options.projectRoot, "app/page.tsx")],
        filesSkipped: [],
        packageJsonUpdated: [],
      };
    });
    const inspect = vi
      .fn(async () => NO_REGISTRATIONS)
      .mockResolvedValueOnce(NO_REGISTRATIONS)
      .mockResolvedValueOnce({ ...NO_REGISTRATIONS, webAppPresent: true });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      signal: controller.signal,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: inspect,
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: ["web"] });
  });

  it("repaints the durable channel before reporting a later Slack failure", async () => {
    const { single, listPaints } = scriptList(["slack", "done"], (opts) => {
      if (/slackbot/i.test(opts.message)) return "yes";
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();
    addChannelsDeps.ensureChannel.mockResolvedValue({
      kind: "slack",
      action: "skipped",
      filesWritten: [],
      filesSkipped: [join(APP_ROOT, "agent/channels/slack.ts")],
      packageJsonUpdated: [],
    });
    addChannelsDeps.reconcileSlackUid.mockResolvedValue(false);
    const inspect = vi
      .fn(async () => NO_REGISTRATIONS)
      .mockResolvedValueOnce(NO_REGISTRATIONS)
      .mockResolvedValueOnce({
        ...NO_REGISTRATIONS,
        slackOwners: ["channels/slack.ts"],
      });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(
          async () => ({ state: "linked", projectId: "prj_1", orgId: "org_1" }) as DeploymentInfo,
        ),
        inspectExistingChannelRegistrations: inspect,
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({
      kind: "failed",
      addedChannels: ["slack"],
      message: "Slack connector UID update is required before deployment.",
    });
    expect(listPaints).toHaveLength(2);
    expect(listPaints[1]?.find((option) => option.value === "slack")).toMatchObject({
      completed: true,
      focusHint: "Already installed",
    });
  });

  it("propagates a provisioning auth error (nothing landed) so the caller can route it", async () => {
    const { single } = scriptList(["slack", "done"], (opts) => {
      if (/slackbot/i.test(opts.message)) return "yes";
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();
    // Provisioning runs before the slack file is scaffolded, so a logged-out
    // failure throws with no channel landed; the flow must re-throw it (the
    // command handler routes it to /vc:login) rather than swallow it.
    addChannelsDeps.provisionSlackbot = vi.fn(async () => {
      throw new HumanActionRequiredError({
        kind: "vercel-login",
        command: "vercel login",
        reason: "not logged in",
      });
    });
    await expect(
      runChannelsFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: {
          detectDeployment: vi.fn(async () => LINKED),
          inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
          getVercelAuthStatus: vi.fn(async (): Promise<VercelAuthStatus> => "authenticated"),
          addChannels: addChannelsDeps,
        },
      }),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });

  it("adds Slack when the directory is linked, with no link pickers", async () => {
    const { single } = scriptList(["slack", "done"], (opts) => {
      if (opts.message === SEE_IT_LIVE_MESSAGE) return "later";
      if (/slackbot/i.test(opts.message)) return "yes";
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(
          async () => ({ state: "linked", projectId: "prj_1", orgId: "org_1" }) as DeploymentInfo,
        ),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: addChannelsDeps,
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: ["slack"] });
    expect(addChannelsDeps.provisionSlackbot).toHaveBeenCalled();
  });

  it("offers 'See it live' after a Slack connection and returns deploy-and-chat on Deploy", async () => {
    const seen: string[] = [];
    const { single } = scriptList(["slack"], (opts) => {
      seen.push(opts.message);
      if (opts.message === SEE_IT_LIVE_MESSAGE) return "deploy";
      if (/slackbot/i.test(opts.message)) return "yes";
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });
    const addChannelsDeps = createAddChannelsDeps();
    // A workspace URL on the connection rides back so the caller can link to it.
    addChannelsDeps.provisionSlackbot = vi.fn(async () => ({
      state: "attached",
      connectorUid: "slack/my-agent",
      chatUrl: "https://app.slack.com/client/T123",
      workspaceName: "Acme",
    }));

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(
          async () => ({ state: "linked", projectId: "prj_1", orgId: "org_1" }) as DeploymentInfo,
        ),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: addChannelsDeps,
      },
    });

    // "Deploy" ends the loop straight away — no second list paint, no Done.
    expect(result).toEqual({
      kind: "deploy-and-chat",
      addedChannels: ["slack"],
      chat: { chatUrl: "https://app.slack.com/client/T123", workspaceName: "Acme" },
    });
    expect(seen).toContain(SEE_IT_LIVE_MESSAGE);
  });

  it("does not offer 'See it live' for a non-Slack channel", async () => {
    const seen: string[] = [];
    const { single } = scriptList(["web", "done"], (opts) => {
      seen.push(opts.message);
      throw new Error(`Unexpected select: ${opts.message}`);
    });
    const fake = createFakePrompter({ single });

    const result = await runChannelsFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        inspectExistingChannelRegistrations: vi.fn(async () => NO_REGISTRATIONS),
        addChannels: createAddChannelsDeps(),
      },
    });

    expect(result).toEqual({ kind: "done", addedChannels: ["web"] });
    expect(seen).not.toContain(SEE_IT_LIVE_MESSAGE);
  });
});
