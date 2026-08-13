import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { RegistryFlowFailedError } from "#setup/flows/registry.js";

import {
  runTuiSetupCommand,
  SETUP_FLOW_CONFIG,
  type TuiSetupCommandInput,
  type TuiSetupCommandRenderer,
  type TuiSetupFlows,
} from "./setup-commands.js";

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
    replaceContent: vi.fn(),
    renderOutput: vi.fn(),
    withInheritedStdio: (task) => task(),
    waitForInterrupt: vi.fn(() => ({
      promise: new Promise<void>((resolve) => {
        fire = resolve;
      }),
      dispose: () => {
        disposed = true;
      },
    })),
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
    runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => ({
      kind: "done",
      addedItems: [],
      items: [],
      facts: [],
    })),
    runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => ({
      kind: "deployed",
      productionUrl: "https://my-agent.vercel.app",
    })),
    ...overrides,
  };
}

function run(input: {
  command: "vc:install" | "vc:login" | "model" | "add" | "deploy";
  flows: TuiSetupFlows;
  renderer?: TuiSetupCommandRenderer;
  initialModelStep?: "provider";
  upgradeChoice?: "upgrade" | "later";
}) {
  const { upgradeChoice } = input;
  const fake = createFakePrompter(
    upgradeChoice === undefined ? {} : { single: () => upgradeChoice },
  );
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
  it("keeps registry setup interruptible through the parent drawer", async () => {
    const renderer = fakePanelRenderer();
    const runRegistryFlow = vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => ({
      kind: "done",
      addedItems: [],
      items: [],
      facts: [],
    }));

    await run({ command: "add", flows: fakeFlows({ runRegistryFlow }), renderer });

    expect(renderer.waitForInterrupt).toHaveBeenCalledWith();
  });

  it("uses the build pulse for every setup command except deploy", () => {
    expect(
      Object.fromEntries(
        Object.entries(SETUP_FLOW_CONFIG).map(([command, config]) => [command, config.indicator]),
      ),
    ).toEqual({
      "vc:install": "pulse",
      "vc:login": "pulse",
      model: "pulse",
      add: "pulse",
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
          resolution: {
            credential: "api-key",
            source: { kind: "env-file", path: ".env.local" },
          },
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
          resolution: { credential: "oidc", file: ".env.local" },
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

  it("names the shadow when a gateway key outranks the freshly linked OIDC token", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
        kind: "done",
        providerOutcome: {
          resolution: {
            credential: "api-key",
            source: { kind: "shell" },
            shadowedOidc: {},
          },
          status: { kind: "gateway-project", projectName: "my-agent", teamName: "my-team" },
        },
      })),
    });
    await expect(run({ command: "model", flows })).resolves.toEqual({
      message:
        "Project linked. AI_GATEWAY_API_KEY (shell) outranks the project's " +
        "VERCEL_OIDC_TOKEN and stays the active credential — unset it in your shell to run " +
        "on the project.",
      preserveFlowDiagnostics: false,
      effect: { kind: "model-access-changed" },
    });
  });

  it("does not claim a link for a pasted key — the outcome names the env file", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => ({
        kind: "done",
        providerOutcome: {
          resolution: {
            credential: "api-key",
            source: { kind: "env-file", path: ".env.local" },
          },
          status: {
            kind: "gateway-key",
            envKey: "AI_GATEWAY_API_KEY",
            source: { kind: "env-file", path: ".env.local" },
          },
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

  it("prompts to upgrade an old Vercel CLI when setup reports it unsupported", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-cli-upgrade",
          command: "vercel upgrade",
          reason: "The installed Vercel CLI does not support the required team-list options.",
        });
      }),
      runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
        kind: "installed",
      })),
    });

    await expect(run({ command: "model", flows, upgradeChoice: "upgrade" })).resolves.toEqual({
      message: "Upgraded the Vercel CLI. Retry /model.",
      preserveFlowDiagnostics: false,
    });
    expect(flows.runInstallVercelCliFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: APP_ROOT,
        upgrade: true,
      }),
    );
  });

  it("gives the manual upgrade command when the old-CLI prompt is declined", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-cli-upgrade",
          command: "vercel upgrade",
          reason: "The installed Vercel CLI does not support the required team-list options.",
        });
      }),
    });

    await expect(run({ command: "model", flows, upgradeChoice: "later" })).resolves.toEqual({
      message: "The Vercel CLI needs an update — run `vercel upgrade`, then retry /model.",
      preserveFlowDiagnostics: true,
    });
    expect(flows.runInstallVercelCliFlow).not.toHaveBeenCalled();
  });

  it("prints a thrown upgrade error with the manual command", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-cli-upgrade",
          command: "vercel upgrade",
          reason: "The installed Vercel CLI does not support the required team-list options.",
        });
      }),
      runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => {
        throw new Error("package manager failed");
      }),
    });

    await expect(run({ command: "model", flows, upgradeChoice: "upgrade" })).resolves.toEqual({
      message:
        "Couldn't upgrade the Vercel CLI (package manager failed) — run `vercel upgrade`, then retry /model.",
      preserveFlowDiagnostics: true,
    });
  });

  it("prints the native CLI failure reason with the manual command", async () => {
    const flows = fakeFlows({
      runModelFlow: vi.fn<TuiSetupFlows["runModelFlow"]>(async () => {
        throw new HumanActionRequiredError({
          kind: "vercel-cli-upgrade",
          command: "vercel upgrade",
          reason: "The installed Vercel CLI does not support the required team-list options.",
        });
      }),
      runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
        kind: "failed",
        reason: "ERR_PNPM_NO_GLOBAL_BIN_DIR Unable to find the global bin directory",
      })),
    });

    await expect(run({ command: "model", flows, upgradeChoice: "upgrade" })).resolves.toEqual({
      message:
        "Couldn't upgrade the Vercel CLI (ERR_PNPM_NO_GLOBAL_BIN_DIR Unable to find the global bin directory) — run `vercel upgrade`, then retry /model.",
      preserveFlowDiagnostics: true,
    });
  });

  it.each([
    [
      "added",
      {
        kind: "done",
        addedItems: ["extension/browser"],
        items: [{ address: "extension/browser", title: "Agent Browser", facts: [], output: [] }],
        facts: [],
      },
      "Added Agent Browser",
    ],
    ["empty", { kind: "done", addedItems: [], items: [], facts: [] }, "No registry items added."],
    [
      "deployed",
      { kind: "done", addedItems: [], items: [], facts: [], deployed: "production" },
      "No registry items added.",
    ],
    ["cancelled", { kind: "cancelled" }, "/add dismissed."],
  ] as const)("reports a %s registry flow", async (_case, result, message) => {
    const runRegistryFlow = vi.fn(async () => result);
    const outcome = await run({ command: "add", flows: fakeFlows({ runRegistryFlow }) });
    const expected: {
      message: string;
      tone?: "success";
      preserveFlowDiagnostics: boolean;
      effect?: { kind: "deployed" };
    } = {
      message,
      preserveFlowDiagnostics: true,
    };
    if (result.kind === "done" && result.addedItems.length > 0) expected.tone = "success";
    if (result.kind === "done" && "deployed" in result && result.deployed === "production") {
      expected.effect = { kind: "deployed" };
    }
    expect(outcome).toEqual(expected);
    expect(runRegistryFlow).toHaveBeenCalledWith(expect.objectContaining({ appRoot: APP_ROOT }));
  });

  it("overrides a settled success tone when add is interrupted", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  kind: "done",
                  addedItems: ["channel/github"],
                  items: [{ address: "channel/github", title: "GitHub", facts: [], output: [] }],
                  facts: [],
                }),
              { once: true },
            );
          }),
      ),
    });

    const result = run({ command: "add", flows, renderer });
    renderer.fireInterrupt();

    await expect(result).resolves.toEqual({
      message: "/add interrupted.",
      tone: "error",
      preserveFlowDiagnostics: true,
    });
  });

  it("reports completed items and facts when a later add fails", async () => {
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => {
        throw new RegistryFlowFailedError(new Error("Refusing to overwrite github.ts"), {
          kind: "done",
          addedItems: ["channel/photon-imessage"],
          items: [
            {
              address: "channel/photon-imessage",
              title: "Photon iMessage",
              output: [],
              facts: [
                { label: "Agent phone number", value: "+15551234567" },
                { label: "Photon project dashboard", value: "https://app.photon.codes/project" },
              ],
            },
          ],
          output: [],
          facts: [
            { label: "Agent phone number", value: "+15551234567" },
            { label: "Photon project dashboard", value: "https://app.photon.codes/project" },
          ],
        });
      }),
    });

    await expect(run({ command: "add", flows })).resolves.toEqual({
      message:
        "Added Photon iMessage\n\n" +
        "Photon iMessage\n" +
        "  Agent phone number        +15551234567\n" +
        "  Photon project dashboard  https://app.photon.codes/project\n\n" +
        "Refusing to overwrite github.ts",
      tone: "error",
      preserveFlowDiagnostics: true,
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
                    resolution: {
                      credential: "api-key",
                      source: { kind: "env-file", path: ".env.local" },
                    },
                    status: {
                      kind: "gateway-key",
                      envKey: "AI_GATEWAY_API_KEY",
                      source: { kind: "env-file", path: ".env.local" },
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
      tone: "error",
      preserveFlowDiagnostics: true,
      effect: { kind: "model-access-changed" },
    });
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
});
