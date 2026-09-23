import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { RegistryFlowFailedError } from "#setup/flows/registry.js";
import type { RegistrySessionResult } from "#setup/flows/registry-session.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  runTuiSetupCommand,
  type TuiSetupCommandInput,
  type TuiSetupCommandRenderer,
  type TuiSetupFlows,
} from "./setup-commands.js";

const APP_ROOT = "/tmp/weather-agent";

function fakePanelRenderer(): TuiSetupCommandRenderer & {
  fireInterrupt: (kind?: "escape" | "ctrl-c") => void;
  interruptDisposed: () => boolean;
} {
  let fire: (kind: "escape" | "ctrl-c") => void = () => {};
  let disposed = false;
  return {
    readSelect: vi.fn(async () => []),
    readEditableSelect: vi.fn(async () => undefined),
    readProviderPicker: vi.fn(async () => undefined),
    readText: vi.fn(async () => ""),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setNavigation: vi.fn(),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    replaceContent: vi.fn(),
    renderOutput: vi.fn(),
    withInheritedStdio: (task) => task(),
    waitForInterrupt: vi.fn(() => ({
      promise: new Promise<"escape" | "ctrl-c">((resolve) => {
        fire = resolve;
      }),
      dispose: () => {
        disposed = true;
      },
    })),
    fireInterrupt: (kind = "escape") => fire(kind),
    interruptDisposed: () => disposed,
  };
}

function registryResult(overrides: Partial<RegistrySessionResult> = {}) {
  return {
    kind: "done" as const,
    result: { outcomes: [], ...overrides },
  };
}

function fakeFlows(overrides: Partial<TuiSetupFlows> = {}): TuiSetupFlows {
  return {
    runInstallVercelCliFlow: vi.fn<TuiSetupFlows["runInstallVercelCliFlow"]>(async () => ({
      kind: "installed",
    })),
    runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => registryResult()),
    runDeployFlow: vi.fn<TuiSetupFlows["runDeployFlow"]>(async () => ({
      kind: "deployed",
      productionUrl: "https://my-agent.vercel.app",
    })),
    ...overrides,
  };
}

function run(input: {
  command: "add" | "deploy";
  flows: TuiSetupFlows;
  renderer?: TuiSetupCommandRenderer;
  initialModelStep?: "provider";
  agentRoot?: string;
  useDefaultPrompter?: boolean;
  upgradeChoice?: "upgrade" | "later";
  withExclusiveTerminal?: TuiSetupCommandInput["withExclusiveTerminal"];
  initialRegistryAddress?: string;
}) {
  const { upgradeChoice } = input;
  const fake = createFakePrompter(
    upgradeChoice === undefined ? {} : { single: () => upgradeChoice },
  );
  const commandInput: TuiSetupCommandInput = {
    command: input.command,
    appRoot: APP_ROOT,
    renderer: input.renderer ?? fakePanelRenderer(),
    flows: input.flows,
  };
  if (input.agentRoot !== undefined) commandInput.agentRoot = input.agentRoot;
  if (input.initialRegistryAddress !== undefined) {
    commandInput.initialRegistryAddress = input.initialRegistryAddress;
  }
  if (input.useDefaultPrompter !== true) commandInput.createPrompter = () => fake.prompter;
  if (input.initialModelStep !== undefined) {
    commandInput.initialModelStep = input.initialModelStep;
  }
  if (input.withExclusiveTerminal !== undefined) {
    commandInput.withExclusiveTerminal = input.withExclusiveTerminal;
  }
  return runTuiSetupCommand(commandInput);
}

describe("runTuiSetupCommand", () => {
  it("arms the interrupt trap before an addressed add opens its confirmation", async () => {
    const calls: string[] = [];
    const renderer = fakePanelRenderer();
    renderer.waitForInterrupt = vi.fn(() => {
      calls.push("interrupt");
      return { promise: new Promise<"escape" | "ctrl-c">(() => {}), dispose: vi.fn() };
    });
    renderer.readSelect = vi.fn(async () => {
      calls.push("select");
      return ["install"];
    });
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async ({ prompter }) => {
        await prompter.select({
          message: "Add eve/self-modification?",
          options: [{ value: "install", label: "Install and set up" }],
        });
        return registryResult();
      }),
    });

    await run({ command: "add", flows, renderer, useDefaultPrompter: true });

    expect(calls).toEqual(["interrupt", "select"]);
  });

  it("suspends the runtime during registry installation", async () => {
    const calls: string[] = [];
    const runRegistryFlow = vi.fn<TuiSetupFlows["runRegistryFlow"]>(async (input) => {
      await input.prompter.withExclusiveTerminal?.(async () => {
        calls.push("install");
      });
      return registryResult();
    });
    const withExclusiveTerminal = async <T>(task: () => Promise<T>): Promise<T> => {
      calls.push("suspend");
      const result = await task();
      calls.push("resume");
      return result;
    };

    await run({
      command: "add",
      flows: fakeFlows({ runRegistryFlow }),
      useDefaultPrompter: true,
      withExclusiveTerminal,
    });

    expect(runRegistryFlow).toHaveBeenCalledWith(
      expect.not.objectContaining({ initialScreen: expect.anything() }),
    );
    expect(calls).toEqual(["suspend", "install", "resume"]);
  });

  it("describes dependency installation while adding an item", async () => {
    const renderer = fakePanelRenderer();
    const runRegistryFlow = vi.fn<TuiSetupFlows["runRegistryFlow"]>(async (input) => {
      input.onItemStart?.(
        { address: "channel/web", name: "channel/web", title: "Web Chat", source: "Vercel" },
        0,
        4,
      );
      return registryResult();
    });

    await run({ command: "add", flows: fakeFlows({ runRegistryFlow }), renderer });

    expect(renderer.setNavigation).toHaveBeenCalledWith(undefined);
    expect(renderer.replaceContent).toHaveBeenCalledWith(undefined);
    expect(renderer.setStatus).toHaveBeenCalledWith("Adding Web Chat · 1 of 4");
  });

  const installed = {
    kind: "installed" as const,
    title: "Agent Browser",
    facts: [],
    output: [],
  };

  it.each([
    [
      "added",
      registryResult({ outcomes: [installed] }),
      { message: "", tone: "success", preserveFlowDiagnostics: false },
    ],
    [
      "deployed",
      registryResult({ outcomes: [installed], deployed: "production" }),
      { message: "", tone: "success", effect: { kind: "deployed" } },
    ],
    ["empty", registryResult(), { message: "", cancelled: true }],
    ["cancelled", { kind: "cancelled" as const }, { message: "", cancelled: true }],
  ] as const)("reports a %s registry flow", async (_case, result, expected) => {
    const runRegistryFlow = vi.fn(async () => result);
    const outcome = await run({ command: "add", flows: fakeFlows({ runRegistryFlow }) });
    expect(outcome).toMatchObject(expected);
    expect(runRegistryFlow).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: APP_ROOT, installRoot: undefined }),
    );
  });

  it("keeps flow warnings only as notes on the add outcome", async () => {
    const renderer = fakePanelRenderer();
    const runRegistryFlow = vi.fn<TuiSetupFlows["runRegistryFlow"]>(async ({ prompter }) => {
      prompter.log.warning("Wait for the Slack request to expire before retrying.");
      return registryResult({
        outcomes: [
          {
            kind: "incomplete",
            title: "channel/slack",
            resumeCommand: "eve add channel/slack --skip-install",
          },
        ],
      });
    });

    await expect(
      run({
        command: "add",
        flows: fakeFlows({ runRegistryFlow }),
        renderer,
        useDefaultPrompter: true,
      }),
    ).resolves.toEqual({
      message:
        "Finish with `eve add channel/slack --skip-install`\n" +
        "⚠ Wait for the Slack request to expire before retrying.",
      summary: "Added channel/slack · setup not finished",
      cancelled: true,
      preserveFlowDiagnostics: false,
    });
  });

  it("keeps shared setup at the workspace root while installing into its agent", async () => {
    const runRegistryFlow = vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => registryResult());
    await run({
      command: "add",
      agentRoot: "/tmp/project/agents/support",
      flows: fakeFlows({ runRegistryFlow }),
    });

    expect(runRegistryFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: APP_ROOT,
        installRoot: "/tmp/project/agents/support",
      }),
    );
  });

  it("reports a failed installation as an error without its flow logs", async () => {
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () =>
        registryResult({
          outcomes: [
            {
              kind: "failed",
              title: "connection/github",
              message: "Refusing to overwrite github.ts",
            },
          ],
        }),
      ),
    });

    await expect(run({ command: "add", flows })).resolves.toEqual({
      message: "Refusing to overwrite github.ts",
      summary: "Couldn't add connection/github",
      tone: "error",
      preserveFlowDiagnostics: false,
    });
  });

  it("reports the production URL after a deploy", async () => {
    const flows = fakeFlows();
    await expect(run({ command: "deploy", flows })).resolves.toEqual({
      message: "Deployed: https://my-agent.vercel.app",
      tone: "success",
      preserveFlowDiagnostics: true,
      effect: { kind: "deployed" },
    });
    expect(flows.runDeployFlow).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
  });

  it("limits an installation interrupt to the active registry item", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async ({ runItem }) => {
        await expect(
          runItem?.(
            (signal) =>
              new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          ),
        ).rejects.toBeInstanceOf(WizardCancelledError);
        return registryResult({ outcomes: [{ kind: "cancelled", title: "channel/slack" }] });
      }),
    });

    const result = run({ command: "add", flows, renderer });
    renderer.fireInterrupt();

    await expect(result).resolves.toEqual({
      message: "",
      summary: "channel/slack not added",
      cancelled: true,
      preserveFlowDiagnostics: false,
    });
  });

  it("summarizes an addressed add that fails before any item settles", async () => {
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async () => {
        throw new Error("Registry unavailable.");
      }),
    });

    await expect(
      run({ command: "add", flows, initialRegistryAddress: "connection/sentry" }),
    ).resolves.toEqual({
      message: "Registry unavailable.",
      summary: "Couldn't add connection/sentry",
      tone: "error",
      preserveFlowDiagnostics: false,
    });
  });

  it("interrupts the whole add command on Ctrl-C during an installation", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(async ({ runItem, signal }) => {
        await expect(
          runItem?.(
            (itemSignal) =>
              new Promise((_resolve, reject) => {
                itemSignal?.addEventListener("abort", () => reject(itemSignal.reason), {
                  once: true,
                });
              }),
          ),
        ).rejects.toBeInstanceOf(WizardCancelledError);
        signal?.throwIfAborted();
        return registryResult();
      }),
    });

    const result = run({ command: "add", flows, renderer });
    renderer.fireInterrupt("ctrl-c");

    await expect(result).resolves.toEqual({
      message: "",
      cancelled: true,
      tone: undefined,
      preserveFlowDiagnostics: false,
    });
  });

  it("interrupts add while non-item work is in progress", async () => {
    const renderer = fakePanelRenderer();
    const flows = fakeFlows({
      runRegistryFlow: vi.fn<TuiSetupFlows["runRegistryFlow"]>(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    });

    const result = run({ command: "add", flows, renderer });
    renderer.fireInterrupt();

    await expect(result).resolves.toEqual({
      message: "",
      cancelled: true,
      tone: undefined,
      preserveFlowDiagnostics: false,
    });
  });

  it("routes a vercel-login action error without dropping completed registry items", async () => {
    const cause = new HumanActionRequiredError({
      kind: "vercel-login",
      command: "vercel login",
      reason: "Provisioning requires Vercel authentication.",
    });
    const flows = fakeFlows({
      runRegistryFlow: vi.fn(async () => {
        throw new RegistryFlowFailedError(cause, {
          outcomes: [
            {
              kind: "installed",
              title: "Web Chat",
              facts: [{ label: "URL", value: "http://localhost:3000" }],
              output: [],
            },
          ],
        });
      }),
    });

    await expect(run({ command: "add", flows })).resolves.toMatchObject({
      message: expect.stringMatching(/^URL {2}http:\/\/localhost:3000\n[\s\S]*run \/deploy/),
      partial: true,
      tone: "error",
    });
  });

  it("routes a forbidden (SSO) scope error to /deploy with a re-auth message", async () => {
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
        "Vercel denied access to that team — check your team access and SSO, then retry /deploy.",
      tone: "error",
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
      message:
        "Human action required: `vercel link` — Deployment needs this directory linked to a Vercel project.",
      tone: "error",
    });
  });

  it("routes a missing-CLI action to the install command instead of /deploy", async () => {
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
      message: "The Vercel CLI isn't installed — run /deploy to install it, then retry /deploy.",
      tone: "error",
      preserveFlowDiagnostics: true,
    });
  });
});
