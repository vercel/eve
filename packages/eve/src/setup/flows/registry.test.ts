import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { PlannerNavigationError } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import { runRegistryFlow, type RegistryFlowDeps } from "./registry.js";

const APP_ROOT = "/tmp/agent";

function deps(overrides: Partial<RegistryFlowDeps> = {}): RegistryFlowDeps {
  return {
    browseRegistryCatalog: vi.fn(async () => ({
      items: [
        {
          address: "channel/web",
          name: "channel/web",
          title: "Web Chat",
          description: "A chat UI for your agent",
          source: "Vercel",
        },
        {
          address: "connection/linear",
          name: "connection/linear",
          title: "Linear",
          description: "Issue tracking",
          source: "Vercel",
        },
      ],
      total: 2,
      errors: [],
    })),
    installRegistryItem: vi.fn(async () => ({ output: [] })),
    detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
    runDeployFlow: vi.fn(async () => ({ kind: "deployed" as const })),
    ...overrides,
  };
}

describe("runRegistryFlow", () => {
  it("plans channels and integrations together, then installs the full plan in order", async () => {
    const answers = ["install"];
    const selections = [["channel/web"], ["connection/linear"]];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => selections.shift()!,
    });
    const flowDeps = deps();
    const starts: string[] = [];

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: flowDeps,
        onItemStart: (item, index, total) => starts.push(`${item.address}:${index + 1}/${total}`),
      }),
    ).resolves.toEqual({
      kind: "done",
      result: {
        items: [
          { title: "Web Chat", facts: [], output: [] },
          { title: "Linear", facts: [], output: [] },
        ],
        failures: [],
      },
    });

    expect(starts).toEqual(["channel/web:1/2", "connection/linear:2/2"]);
    expect(flowDeps.installRegistryItem).toHaveBeenNthCalledWith(
      1,
      APP_ROOT,
      "channel/web",
      expect.objectContaining({ silent: true, prompter: fake.prompter }),
    );
    expect(flowDeps.installRegistryItem).toHaveBeenNthCalledWith(
      2,
      APP_ROOT,
      "connection/linear",
      expect.objectContaining({ silent: true, prompter: fake.prompter }),
    );
  });

  it("orders first-party Photon before non-featured channel providers", async () => {
    const channelLabels: string[] = [];
    const fake = createFakePrompter({
      multiple: (options) => {
        if (options.message === "Where should people reach your agent?") {
          channelLabels.push(...options.options.map((option) => option.label));
        }
        return [];
      },
      single: () => "install",
    });
    const flowDeps = deps({
      browseRegistryCatalog: vi.fn(async () => ({
        items: [
          { address: "channel/blooio", name: "channel/blooio", title: "Blooio", source: "Vercel" },
          {
            address: "channel/photon-imessage",
            name: "channel/photon-imessage",
            title: "Photon iMessage",
            source: "Vercel",
          },
        ],
        total: 2,
        errors: [],
      })),
    });

    await runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps });

    expect(channelLabels).toEqual(["Photon iMessage", "Blooio"]);
  });

  it("lets the user browse, retain selections, and review the plan before installing", async () => {
    const answers = ["install"];
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return answers.shift()!;
      },
      multiple: (options) => {
        prompts.push(options);
        return options.message === "What should your agent be able to work with?"
          ? ["connection/linear"]
          : [];
      },
    });

    await runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: deps() });

    expect(prompts[0]).toMatchObject({
      message: "Where should people reach your agent?",
      description: "You can add more later with /add.",
      multiple: true,
      search: true,
      placeholder: "Search channels",
    });
    expect(prompts[1]).toMatchObject({
      message: "What should your agent be able to work with?",
      multiple: true,
      search: true,
      placeholder: "Search integrations",
    });
    expect(prompts[2]).toMatchObject({
      message: "Review additions",
      navigation: {
        kind: "planner",
        activeStep: 2,
        steps: [{ label: "Channels" }, { label: "Integrations", count: 1 }, { label: "Review" }],
      },
      metadata: [{ label: "Integrations", value: "Linear" }],
      options: [
        { value: "install", label: "Install and set up" },
        { value: "back", label: "Back" },
      ],
    });
  });

  it("prefixes onboarding progress without changing standalone review", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return "install";
      },
      multiple: (options) => {
        prompts.push(options);
        return [];
      },
    });

    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: deps(),
      plannerContext: {
        prefixSteps: [{ label: "Model", complete: true }],
        reviewMessage: "Review your agent",
        emptyActionLabel: "Finish setup",
      },
    });

    expect(prompts[0]).toMatchObject({
      navigation: {
        activeStep: 1,
        steps: [
          { label: "Model", complete: true },
          { label: "Channels" },
          { label: "Integrations" },
          { label: "Review" },
        ],
      },
    });
    expect(prompts[2]).toMatchObject({
      metadata: [],
      options: [
        { value: "install", label: "Finish setup" },
        { value: "back", label: "Back" },
      ],
    });
  });

  it("starts bare /add on channels and keeps empty Review open", async () => {
    const prompts: unknown[] = [];
    const screens: Array<{ screen: string; registrySelectedCount?: number }> = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return "install";
      },
      multiple: (options) => {
        prompts.push(options);
        return [];
      },
    });

    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      onScreen: (screen) => screens.push(screen),
      deps: deps(),
    });

    expect(screens).toEqual([
      { screen: "registry_channels" },
      { screen: "registry_integrations" },
      { screen: "registry_review", registrySelectedCount: 0 },
      { screen: "registry_install" },
    ]);
    expect(prompts).toMatchObject([
      { message: "Where should people reach your agent?" },
      { message: "What should your agent be able to work with?" },
      {
        message: "Review additions",
        description: "No channels or integrations selected.",
        options: [
          { value: "install", label: "Finish without adding" },
          { value: "back", label: "Back" },
        ],
      },
    ]);
  });

  it("preserves selections while navigating forward and back with arrow keys", async () => {
    let lap = 0;
    const fake = createFakePrompter({
      single: () => "install",
      multiple: (options) => {
        lap += 1;
        if (lap === 1) throw new PlannerNavigationError("forward", ["channel/web"]);
        if (lap === 2) throw new PlannerNavigationError("back", ["connection/linear"]);
        if (lap === 3) {
          expect(options.initialValues).toEqual(["channel/web"]);
          return ["channel/web"];
        }
        expect(options.initialValues).toEqual(["connection/linear"]);
        return ["connection/linear"];
      },
    });
    const installRegistryItem = vi.fn<RegistryFlowDeps["installRegistryItem"]>(async () => ({
      output: [],
    }));

    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: deps({ installRegistryItem }),
    });

    expect(installRegistryItem).toHaveBeenCalledTimes(2);
  });

  it("puts curated choices first while preserving registry order for the remaining entries", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: () => "install",
      multiple: (options) => {
        prompts.push(options);
        return [];
      },
    });
    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: deps({
        browseRegistryCatalog: vi.fn(async () => ({
          items: [
            {
              address: "channel/discord",
              name: "channel/discord",
              title: "Discord",
              source: "Vercel",
            },
            { address: "channel/slack", name: "channel/slack", title: "Slack", source: "Vercel" },
            { address: "channel/web", name: "channel/web", title: "Web Chat", source: "Vercel" },
            {
              address: "channel/github",
              name: "channel/github",
              title: "GitHub",
              source: "Vercel",
            },
            {
              address: "channel/telegram",
              name: "channel/telegram",
              title: "Telegram",
              source: "Vercel",
            },
          ],
          total: 5,
          errors: [],
        })),
      }),
    });

    expect(
      (prompts[0] as { options: { value: string }[] }).options.map((option) => option.value),
    ).toEqual([
      "channel/web",
      "channel/slack",
      "channel/github",
      "channel/discord",
      "channel/telegram",
    ]);
  });

  it("confirms and installs an explicitly requested address without opening the planner", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return "install";
      },
    });
    const browseRegistryCatalog = vi.fn<RegistryFlowDeps["browseRegistryCatalog"]>();
    const installRegistryItem = vi.fn<RegistryFlowDeps["installRegistryItem"]>(async () => ({
      output: [],
    }));

    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      initialAddress: "@acme/analytics",
      deps: deps({ browseRegistryCatalog, installRegistryItem }),
    });

    expect(prompts).toMatchObject([
      {
        message: "Add @acme/analytics?",
        options: [
          { value: "install", label: "Install and set up" },
          { value: "cancel", label: "Cancel" },
        ],
      },
    ]);
    expect(browseRegistryCatalog).not.toHaveBeenCalled();
    expect(installRegistryItem).toHaveBeenCalledWith(
      APP_ROOT,
      "@acme/analytics",
      expect.objectContaining({ silent: true }),
    );
  });

  it("surfaces registry source failures on the planner", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: () => "install",
      multiple: (options) => {
        prompts.push(options);
        return [];
      },
    });

    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: deps({
        browseRegistryCatalog: vi.fn(async () => ({
          items: [],
          total: 0,
          errors: [{ registry: "@acme", message: "Authentication required" }],
        })),
      }),
    });

    expect(prompts[0]).toMatchObject({
      notices: [{ tone: "warning", text: "@acme: Authentication required" }],
    });
  });

  it("propagates cancellation during installation instead of recording a failure", async () => {
    const answers = ["install"];
    const selections = [["channel/web"], []];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => selections.shift()!,
    });
    const controller = new AbortController();
    const reason = new Error("Setup interrupted");
    const installRegistryItem = vi.fn<RegistryFlowDeps["installRegistryItem"]>(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        signal: controller.signal,
        deps: deps({ installRegistryItem }),
      }),
    ).rejects.toBe(reason);
    expect(fake.selectMessages).not.toContain("Couldn't add Web Chat");
  });

  it("keeps a skipped installation failure in the result and proceeds with later items", async () => {
    const answers = ["install", "skip"];
    const selections = [["channel/web"], ["connection/linear"]];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => selections.shift()!,
    });
    const installRegistryItem = vi
      .fn<RegistryFlowDeps["installRegistryItem"]>()
      .mockRejectedValueOnce(new Error("Missing WEB_TOKEN\nSet it in your environment."))
      .mockResolvedValueOnce({ output: [] });

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: deps({ installRegistryItem }),
      }),
    ).resolves.toMatchObject({
      kind: "done",
      result: {
        items: [expect.objectContaining({ title: "Linear" })],
        failures: [
          expect.objectContaining({
            title: "Web Chat",
            message: "Missing WEB_TOKEN\nSet it in your environment.",
          }),
        ],
      },
    });
    expect(fake.selectMessages).toContain("Couldn't add Web Chat");
  });

  it("preserves an installation failure when its recovery prompt is cancelled", async () => {
    let prompt = 0;
    const fake = createFakePrompter({
      single: () => (++prompt === 1 ? "install" : Promise.reject(new WizardCancelledError())),
    });

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        initialAddress: "channel/web",
        deps: deps({
          installRegistryItem: vi.fn(async () => {
            throw new Error("Missing WEB_TOKEN\nSet it in your environment.");
          }),
        }),
      }),
    ).resolves.toMatchObject({
      result: {
        failures: [{ title: "web", message: expect.stringContaining("WEB_TOKEN") }],
        cancelled: true,
      },
    });
  });

  it("preserves a cancelled item when a later item fails fatally", async () => {
    const answers = ["install"];
    const selections = [["channel/web"], ["connection/linear"]];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => selections.shift()!,
    });
    const cause = new HumanActionRequiredError({
      kind: "vercel-login",
      command: "vercel login",
      reason: "Authentication required.",
    });
    const installRegistryItem = vi
      .fn<RegistryFlowDeps["installRegistryItem"]>()
      .mockRejectedValueOnce(new WizardCancelledError())
      .mockRejectedValueOnce(cause);

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: deps({ installRegistryItem }),
      }),
    ).rejects.toMatchObject({
      cause,
      completed: {
        outcomes: [{ kind: "cancelled", title: "Web Chat" }],
      },
    });
  });

  it("lets structured setup failures reach the command boundary", async () => {
    const answers = ["install"];
    const selections = [["channel/web"], []];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => selections.shift()!,
    });
    const error = new HumanActionRequiredError({
      kind: "vercel-cli-upgrade",
      command: "vercel upgrade",
      reason: "The installed Vercel CLI is too old.",
    });

    await expect(
      runRegistryFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: deps({
          installRegistryItem: vi.fn(async () => {
            throw error;
          }),
        }),
      }),
    ).rejects.toBe(error);
    expect(fake.selectMessages).not.toContain("Couldn't add Web Chat");
  });

  it("offers deployment once after the selected batch completes", async () => {
    const answers = ["install", "deploy", "yes"];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => ["channel/web"],
    });
    const replaceContent = vi.fn();
    fake.prompter.replaceContent = replaceContent;
    const flowDeps = deps({
      detectDeployment: vi.fn(async () => ({ state: "linked" as const, projectId: "prj_1" })),
      installRegistryItem: vi.fn(async () => ({
        output: [],
        setup: { facts: [], deploymentRequired: true as const },
      })),
    });

    await expect(
      runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps }),
    ).resolves.toMatchObject({ kind: "done", result: { deployed: "production" } });
    expect(flowDeps.runDeployFlow).toHaveBeenCalledOnce();
    expect(replaceContent).toHaveBeenCalledWith();
    expect(fake.selectMessages).not.toContain("Add an integration");
  });
});
