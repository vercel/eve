import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

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
        kind: "done",
        addedItems: ["channel/web", "connection/linear"],
        items: [
          { address: "channel/web", title: "Web Chat", facts: [], output: [] },
          { address: "connection/linear", title: "Linear", facts: [], output: [] },
        ],
        failures: [],
        facts: [],
        output: [],
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
      message: "Review your agent",
      plannerBack: true,
      metadata: [{ label: "Integration", value: "Linear" }],
      options: [
        { value: "install", label: "Install and set up" },
        { value: "back", label: "Back" },
      ],
    });
  });

  it("puts curated choices first while preserving registry order for the remaining entries", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
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

  it("recommends Linear MCP after Linear Agent and hides the overlapping preset", async () => {
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: () => "install",
      multiple: (options) => {
        prompts.push(options);
        return options.message === "Where should people reach your agent?"
          ? ["channel/linear-agent"]
          : [];
      },
    });
    await runRegistryFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      deps: deps({
        browseRegistryCatalog: vi.fn(async () => ({
          items: [
            { address: "linear", name: "linear", title: "Linear", source: "Vercel" },
            {
              address: "channel/linear-agent",
              name: "channel/linear-agent",
              title: "Linear Agent",
              source: "Vercel",
            },
            {
              address: "connection/linear",
              name: "connection/linear",
              title: "Linear",
              description: "Issues, projects, cycles, and comments via Linear's MCP server.",
              source: "Vercel",
            },
          ],
          total: 3,
          errors: [],
        })),
      }),
    });

    const channelOptions = (prompts[0] as { options: { value: string }[] }).options;
    const integrationOptions = (
      prompts[1] as {
        options: { value: string; label: string; hint?: string }[];
      }
    ).options;
    expect(channelOptions.map((option) => option.value)).toEqual(["channel/linear-agent"]);
    expect(integrationOptions).toEqual([
      {
        value: "connection/linear",
        label: "Linear MCP",
        hint: "Recommended with Linear Agent · Issues, projects, cycles, and comments via Linear's MCP server.",
        featured: true,
      },
    ]);
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
        addedItems: ["connection/linear"],
        failures: [expect.objectContaining({ title: "Web Chat", message: "Missing WEB_TOKEN" })],
      },
    });
    expect(fake.selectMessages).toContain("Couldn't add Web Chat");
  });

  it("offers deployment once after the selected batch completes", async () => {
    const answers = ["install", "deploy", "yes"];
    const fake = createFakePrompter({
      single: () => answers.shift()!,
      multiple: () => ["channel/web"],
    });
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
    expect(fake.selectMessages).not.toContain("Add an integration");
  });
});
