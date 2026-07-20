import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  runTuiSetupCommand,
  SETUP_FLOW_CONFIG,
  type TuiSetupCommandInput,
  type TuiSetupCommandRenderer,
  type TuiSetupFlows,
} from "./setup-commands.js";

// runDeployAndChat opens the chat URL in a browser; stub the opener so the unit
// test never spawns a real OS process.
vi.mock("#setup/primitives/open-url.js", () => ({ openUrl: vi.fn() }));

const APP_ROOT = "/tmp/weather-agent";

function fakePanelRenderer(): TuiSetupCommandRenderer & {
  fireInterrupt: () => void;
  interruptDisposed: () => boolean;
} {
  let fire: () => void = () => {};
  let disposed = false;
  return {
    readSelect: vi.fn(async () => []),
    readEditableSelect: vi.fn(async () => undefined),
    readProviderPicker: vi.fn(async () => undefined),
    readModelEditor: vi.fn(async () => undefined),
    readText: vi.fn(async () => ""),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    renderOutput: vi.fn(),
    waitForInterrupt: () => ({
      promise: new Promise<void>((resolve) => {
        fire = resolve;
      }),
      dispose: () => {
        disposed = true;
      },
    }),
    fireInterrupt: () => fire(),
    interruptDisposed: () => disposed,
  };
}

function fakeFlows(overrides: Partial<TuiSetupFlows> = {}): TuiSetupFlows {
  return {
    runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
      kind: "installed",
    })),
    runLoginFlow: vi.fn<TuiSetupFlows["runLoginFlow"]>(async () => ({ kind: "logged-in" })),
    runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
      kind: "done",
      modelMessage: "Model changed to openai/gpt-5.5. Live on your next prompt.",
    })),
    runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
      kind: "done",
      addedChannels: [],
    })),
    runConnectionsFlow: vi.fn<TuiSetupFlows["runConnectionsFlow"]>(async () => ({
      kind: "done",
      addedConnections: [],
    })),
    runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => ({
      kind: "deployed",
      productionUrl: "https://my-agent.vercel.app",
    })),
    ...overrides,
  };
}

function run(input: {
  command: "vc:install" | "vc:login" | "model" | "channels" | "connect" | "deploy";
  flows: TuiSetupFlows;
  renderer?: TuiSetupCommandRenderer;
  initialModelStep?: "provider";
}) {
  const fake = createFakePrompter({});
  const commandInput: TuiSetupCommandInput = {
    command: input.command,
    appRoot: APP_ROOT,
    renderer: input.renderer ?? fakePanelRenderer(),
    createPrompter: () => fake.prompter,
    flows: input.flows,
  };
  if (input.initialModelStep !== undefined) {
    commandInput.initialModelStep = input.initialModelStep;
  }
  return runTuiSetupCommand(commandInput);
}

describe("runTuiSetupCommand", () => {
  it("uses the build pulse for every setup command except deploy", () => {
    expect(
      Object.fromEntries(
        Object.entries(SETUP_FLOW_CONFIG).map(([command, config]) => [command, config.indicator]),
      ),
    ).toEqual({
      "vc:install": "pulse",
      "vc:login": "pulse",
      model: "pulse",
      channels: "pulse",
      connect: "pulse",
      deploy: "spinner",
    });
  });

  it("surfaces the model flow's apply line as the outcome", async () => {
    const flows = fakeFlows();
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message: "Model changed to openai/gpt-5.5. Live on your next prompt.",
      preserveFlowDiagnostics: false,
    });
    expect(flows.runModelFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: APP_ROOT,
        deps: expect.objectContaining({ runProviderFlow: expect.any(Function) }),
      }),
    );
  });

  it("forwards an automatic provider entry to the model flow", async () => {
    const flows = fakeFlows();

    await run({ command: "model", flows, initialModelStep: "provider" });

    expect(flows.runModelFlow).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: APP_ROOT, initialStep: "provider" }),
    );
  });

  it("stacks the model and provider outcome lines when both menu actions ran", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
        kind: "done",
        modelMessage: "Model changed to openai/gpt-5.5. Live on your next prompt.",
        providerOutcome: {
          credential: "AI_GATEWAY_API_KEY",
          status: { kind: "gateway-project", projectName: "my-agent" },
        },
      })),
    });
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message:
        "Model changed to openai/gpt-5.5. Live on your next prompt.\n" +
        "Project linked. Connected to AI Gateway via AI_GATEWAY_API_KEY.",
      preserveFlowDiagnostics: false,
      effect: { kind: "model-access-changed" },
    });
  });

  it("reports a provider-only model session with the provider outcome", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
        kind: "done",
        providerOutcome: {
          credential: "VERCEL_OIDC_TOKEN",
          status: { kind: "gateway-project", projectName: "my-agent", teamName: "my-team" },
        },
      })),
    });
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message: "Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.",
      preserveFlowDiagnostics: false,
      effect: { kind: "model-access-changed" },
    });
  });

  it("does not claim a link for a pasted key — the outcome names the env file", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
        kind: "done",
        providerOutcome: {
          credential: "AI_GATEWAY_API_KEY",
          status: { kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", envFile: ".env.local" },
        },
      })),
    });
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message: "Connected to AI Gateway via AI_GATEWAY_API_KEY in .env.local.",
      preserveFlowDiagnostics: false,
      effect: { kind: "model-access-changed" },
    });
  });

  it("reports a cancelled model pick", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({ kind: "cancelled" })),
    });
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message: "/model dismissed.",
      preserveFlowDiagnostics: false,
    });
  });

  it("reports the added channels with the deploy hint", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "done",
        addedChannels: ["slack"],
      })),
    });

    const notice = await run({ command: "channels", flows });

    expect(notice).toEqual({
      message: "Channels added: slack — run /deploy to ship them.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
    expect(flows.runChannelsFlow).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: APP_ROOT }),
    );
  });

  it("deploys, then opens and surfaces the Slack message deep link on deploy-and-chat", async () => {
    vi.mocked(openUrl).mockClear();
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: { chatUrl: "https://slack.com/app_redirect?app=A0&team=T0", workspaceName: "Acme" },
      })),
    });

    const notice = await run({ command: "channels", flows });

    // The app_redirect link is upgraded to the Messages tab (a DM compose) and
    // opened in the browser — nothing else opens one at this step.
    const expectedUrl = "https://slack.com/app_redirect?app=A0&team=T0&tab=messages";
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(expectedUrl);
    expect(notice).toEqual({
      message:
        "Deployed: https://my-agent.vercel.app\n" + `Chat with your agent in Slack: ${expectedUrl}`,
      preserveFlowDiagnostics: true,
      effect: { kind: "deployed" },
    });
    expect(flows.runDeployFlow).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
  });

  it("reports the deploy outcome plainly when no Slack workspace URL is known", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
    });

    const notice = await run({ command: "channels", flows });

    expect(notice).toEqual({
      message: "Deployed: https://my-agent.vercel.app\nMessage your agent in Slack to see it live.",
      preserveFlowDiagnostics: true,
      effect: { kind: "deployed" },
    });
  });

  it("keeps the added channels pending when deploy-and-chat is cancelled", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => ({ kind: "cancelled" })),
    });

    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message: "Channels added, but /deploy was dismissed. Run /deploy to ship them.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });

  it("keeps the added channels pending when deploy-and-chat needs a link", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => ({ kind: "needs-link" })),
    });

    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message:
        "Channels added, but this directory is not linked to Vercel. Run /model, then /deploy.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });

  it("keeps the added channels pending when deploy-and-chat fails", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new Error("build failed");
      }),
    });

    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message: "Channels added, but /deploy failed: build failed",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });

  it("reports an empty channels pick", async () => {
    const notice = await run({ command: "channels", flows: fakeFlows() });

    expect(notice).toEqual({
      message: "No channels added.",
      preserveFlowDiagnostics: true,
    });
  });

  it.each([
    [
      "configured",
      { kind: "done", addedConnections: ["linear", "notion"] },
      "Connections added: linear, notion.",
      { kind: "connection-added" },
    ],
    [
      "empty",
      { kind: "done", addedConnections: [] },
      "No connections added.",
      { kind: "model-access-changed" },
    ],
    ["cancelled", { kind: "cancelled" }, "/connect dismissed.", { kind: "model-access-changed" }],
    [
      "partially failed",
      { kind: "failed", addedConnections: ["linear"], message: "install failed" },
      "Connection files changed, but /connect failed: install failed",
      { kind: "connection-added" },
    ],
    [
      "failed before a connection file was written",
      { kind: "failed", addedConnections: [], message: "connector setup failed" },
      "/connect failed: connector setup failed",
      { kind: "model-access-changed" },
    ],
  ] as const)("reports %s connection flows", async (_case, result, message, effect) => {
    const runConnectionsFlow = vi.fn(async () => result);
    await expect(
      run({ command: "connect", flows: fakeFlows({ runConnectionsFlow }) }),
    ).resolves.toEqual({
      message,
      preserveFlowDiagnostics: true,
      effect,
    });
    expect(runConnectionsFlow).toHaveBeenCalledWith(expect.objectContaining({ appRoot: APP_ROOT }));
  });

  it("keeps deploy pending when channel files landed before a sub-flow failure", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "failed",
        addedChannels: ["slack"],
        message: "Slack connector UID update is required before deployment.",
      })),
    });

    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message:
        "Channel files changed, but /channels failed: Slack connector UID update is required before deployment.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });

  it("reports the production URL after a deploy", async () => {
    const flows = fakeFlows();
    await expect(run({ command: "deploy", flows })).resolves.toEqual({
      message: "Deployed: https://my-agent.vercel.app",
      preserveFlowDiagnostics: true,
      effect: { kind: "deployed" },
    });
    expect(flows.runDeployFlow).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
  });

  it("folds flow errors and cancellations into the notice", async () => {
    const failing = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => {
        throw new Error("vercel CLI not found");
      }),
    });
    await expect(run({ command: "channels", flows: failing })).resolves.toEqual({
      message: "/channels failed: vercel CLI not found",
      preserveFlowDiagnostics: true,
    });

    const cancelling = fakeFlows({
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new WizardCancelledError();
      }),
    });
    await expect(run({ command: "deploy", flows: cancelling })).resolves.toEqual({
      message: "/deploy dismissed.",
      preserveFlowDiagnostics: true,
    });
  });

  it("clears the flow status even when the flow throws mid-wait", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => {
        renderer.setStatus("Checking the current Vercel link...");
        throw new Error("network down");
      }),
    });

    await expect(run({ command: "channels", flows, renderer })).resolves.toEqual({
      message: "/channels failed: network down",
      preserveFlowDiagnostics: true,
    });
    expect(renderer.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("retains command ownership until an interrupted flow finishes unwinding", async () => {
    const renderer = fakePanelRenderer();
    let releaseFlow: () => void = () => {};
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(
        () =>
          new Promise((resolve) => {
            releaseFlow = () => resolve({ kind: "cancelled" });
          }),
      ),
    });

    const result = run({ command: "channels", flows, renderer });
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    renderer.fireInterrupt();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseFlow();
    await expect(result).resolves.toEqual({
      message: "/channels interrupted.",
      preserveFlowDiagnostics: true,
    });
    expect(renderer.interruptDisposed()).toBe(true);
    expect(renderer.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps channels pending when deploy-and-chat is interrupted", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
          }),
      ),
    });

    const result = run({ command: "channels", flows, renderer });
    await vi.waitFor(() => expect(flows.runDeployFlow).toHaveBeenCalled());
    renderer.fireInterrupt();

    await expect(result).resolves.toEqual({
      message: "/channels interrupted.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });

  it("preserves model access refreshes when provider setup is interrupted", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  kind: "done",
                  providerOutcome: {
                    credential: "AI_GATEWAY_API_KEY",
                    status: {
                      kind: "gateway-key",
                      envKey: "AI_GATEWAY_API_KEY",
                      envFile: ".env.local",
                    },
                  },
                }),
              { once: true },
            );
          }),
      ),
    });

    const result = run({ command: "model", flows, renderer });
    renderer.fireInterrupt();

    await expect(result).resolves.toEqual({
      message: "/model interrupted.",
      preserveFlowDiagnostics: true,
      effect: { kind: "model-access-changed" },
    });
  });

  it("keeps cleanup diagnostics while muting abandoned progress after an interrupt", async () => {
    const renderer = fakePanelRenderer();
    let releaseFlow: () => void = () => {};
    let flowSignal: AbortSignal | undefined;
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async ({ prompter, signal }) => {
        flowSignal = signal;
        await new Promise<void>((resolve) => {
          releaseFlow = resolve;
        });
        // The abandoned flow resumes after the subprocess finally settles.
        // Narrative progress and prompts stay muted, but cleanup diagnostics
        // must survive so the closed panel can persist them.
        prompter.log.info("late line");
        prompter.log.warning("cleanup could not be verified");
        await prompter.select({ message: "late question", options: [{ value: "a", label: "A" }] });
        return { kind: "done", addedChannels: [] };
      }),
    });

    // The real TUI prompter, so the muted renderer is actually exercised.
    const result = runTuiSetupCommand({ command: "channels", appRoot: APP_ROOT, renderer, flows });
    renderer.fireInterrupt();
    await vi.waitFor(() => expect(flowSignal?.aborted).toBe(true));

    vi.mocked(renderer.renderLine).mockClear();
    vi.mocked(renderer.readSelect).mockClear();
    releaseFlow();
    await expect(result).resolves.toMatchObject({
      message: "/channels interrupted.",
    });

    expect(renderer.renderLine).toHaveBeenCalledOnce();
    expect(renderer.renderLine).toHaveBeenCalledWith("cleanup could not be verified", "warning");
    expect(renderer.readSelect).not.toHaveBeenCalled();
  });

  it("reports a completed login and refreshes the link identity", async () => {
    const flows = fakeFlows({
      runLoginFlow: vi.fn<TuiSetupFlows["runLoginFlow"]>(async () => ({ kind: "logged-in" })),
    });
    await expect(run({ command: "vc:login", flows })).resolves.toEqual({
      message: "Logged in to Vercel.",
      preserveFlowDiagnostics: false,
      effect: { kind: "refresh-identity" },
    });
  });

  it("reports an already-authenticated login as a no-op", async () => {
    const flows = fakeFlows({
      runLoginFlow: vi.fn<TuiSetupFlows["runLoginFlow"]>(async () => ({ kind: "already" })),
    });
    await expect(run({ command: "vc:login", flows })).resolves.toEqual({
      message: "You're already logged in to Vercel.",
      preserveFlowDiagnostics: false,
    });
  });

  it("routes a missing CLI from /vc:login to /vc:install", async () => {
    const flows = fakeFlows({
      runLoginFlow: vi.fn<TuiSetupFlows["runLoginFlow"]>(async () => ({ kind: "cli-missing" })),
    });
    await expect(run({ command: "vc:login", flows })).resolves.toEqual({
      message:
        "The Vercel CLI isn't installed — run /vc:install to install it, then retry /vc:login.",
      preserveFlowDiagnostics: true,
    });
  });

  it("reports an unavailable Vercel API without asking the user to log in again", async () => {
    const flows = fakeFlows({
      runLoginFlow: vi.fn<TuiSetupFlows["runLoginFlow"]>(async () => ({ kind: "unavailable" })),
    });
    await expect(run({ command: "vc:login", flows })).resolves.toEqual({
      message: "Couldn't reach Vercel — check your connection, then retry /vc:login.",
      preserveFlowDiagnostics: true,
    });
  });

  it("routes a vercel-login action error to /vc:login instead of a raw failure", async () => {
    const flows = fakeFlows({
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-login",
          command: "vercel login",
          reason: "Provisioning a Vercel project requires you to be logged in to Vercel.",
        });
      }),
    });
    await expect(run({ command: "deploy", flows })).resolves.toEqual({
      message: "You're not logged in to Vercel — run /vc:login, then retry /deploy.",
      preserveFlowDiagnostics: true,
    });
  });

  it("routes a forbidden (SSO) scope error to /vc:login with a re-auth message", async () => {
    const flows = fakeFlows({
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-forbidden",
          command: "vercel login",
          reason: "Vercel denied access to this scope. Re-authenticate to complete SSO.",
        });
      }),
    });
    await expect(run({ command: "deploy", flows })).resolves.toEqual({
      message:
        "Vercel denied access to that team — run /vc:login to re-authenticate (for example to complete SSO), or pick a team you can access, then retry /deploy.",
      preserveFlowDiagnostics: true,
    });
  });

  it("leaves a non-login human-action error as a generic failure", async () => {
    const flows = fakeFlows({
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-link",
          command: "vercel link",
          reason: "Deployment needs this directory linked to a Vercel project.",
        });
      }),
    });
    await expect(run({ command: "deploy", flows })).resolves.toMatchObject({
      message: expect.stringMatching(/^\/deploy failed: /),
    });
  });

  it("routes a missing-CLI action to the install command instead of /vc:login", async () => {
    const flows = fakeFlows({
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-cli-missing",
          command: "npm i -g vercel@latest",
          reason: "Vercel CLI not found.",
        });
      }),
    });
    await expect(run({ command: "deploy", flows })).resolves.toEqual({
      message:
        "The Vercel CLI isn't installed — run /vc:install to install it, then retry /deploy.",
      preserveFlowDiagnostics: true,
    });
  });

  it("reports an installed CLI and refreshes the link identity", async () => {
    const flows = fakeFlows({
      runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
        kind: "installed",
      })),
    });
    await expect(run({ command: "vc:install", flows })).resolves.toEqual({
      message: "Installed the Vercel CLI. Run /vc:login next.",
      preserveFlowDiagnostics: false,
      effect: { kind: "refresh-identity" },
    });
  });

  it("reports an already-installed CLI as a no-op", async () => {
    const flows = fakeFlows({
      runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
        kind: "already",
      })),
    });
    await expect(run({ command: "vc:install", flows })).resolves.toEqual({
      message: "The Vercel CLI is already installed.",
      preserveFlowDiagnostics: false,
    });
  });

  it("routes a /channels provisioning login error to /vc:login (not the raw message)", async () => {
    // Provisioning throws before any channel lands, so the flow re-throws and
    // the command catch routes it — the same path /deploy uses.
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-login",
          command: "vercel login",
          reason: "not logged in",
        });
      }),
    });
    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message: "You're not logged in to Vercel — run /vc:login, then retry /channels.",
      preserveFlowDiagnostics: true,
    });
  });

  it("routes a deploy-and-chat login action to /vc:login while keeping channels added", async () => {
    const flows = fakeFlows({
      runChannelsFlow: vi.fn<TuiSetupFlows["runChannelsFlow"]>(async () => ({
        kind: "deploy-and-chat",
        addedChannels: ["slack"],
        chat: {},
      })),
      runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-login",
          command: "vercel login",
          reason: "not logged in",
        });
      }),
    });
    await expect(run({ command: "channels", flows })).resolves.toEqual({
      message:
        "Channels added. You're not logged in to Vercel — run /vc:login, then retry /deploy.",
      preserveFlowDiagnostics: true,
      effect: { kind: "channels-added" },
    });
  });
});
