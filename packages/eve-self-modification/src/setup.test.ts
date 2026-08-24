import { describe, expect, it, vi } from "vitest";

import type {
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  RegistrySetupClient,
  SingleSelectOptions,
} from "eve/setup";

import {
  inspectSelfModificationConfig,
  parseGitHubRemote,
  renderSelfModificationConfig,
  runSelfModificationSetup,
  type ReviewSetupValues,
  type SelfModificationSetupOperations,
} from "./setup.js";

const DEVELOPMENT_CONFIG = `import { defineSelfModificationConfig } from "@eve/self-modification/config";

export default defineSelfModificationConfig({});
`;
const VALUES: ReviewSetupValues = { branch: "main", repository: "github.com/acme/agent" };

function setupHarness(input: {
  readonly config?: string;
  readonly selections?: Readonly<Record<string, string | string[]>>;
  readonly texts?: Readonly<Record<string, string>>;
}) {
  let config = input.config;
  const complete = vi.fn();
  const writeConfig = vi.fn(async (source: string) => {
    config = source;
  });
  function select<T extends PrompterValue>(options: SingleSelectOptions<T>): Promise<T>;
  function select<T extends PrompterValue>(options: MultiSelectOptions<T>): Promise<T[]>;
  async function select<T extends PrompterValue>(
    options: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    const value = input.selections?.[options.message];
    if (value === undefined) throw new Error(`Missing selection for ${options.message}`);
    return value as T | T[];
  }
  const text: Prompter["text"] = async (options) => {
    const value = input.texts?.[options.message] ?? options.defaultValue;
    if (value === undefined) throw new Error(`Missing text for ${options.message}`);
    return value;
  };
  const prompter: Prompter = {
    intro: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    password: vi.fn(async () => "secret"),
    log: {
      commandOutput: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    select,
    text,
  };
  const client = {
    cancel: vi.fn(),
    complete,
    fail: vi.fn(),
    prompter,
    signal: new AbortController().signal,
  } satisfies RegistrySetupClient;
  const operations: SelfModificationSetupOperations = {
    detectGitRepository: vi.fn(async () => ({
      owner: "acme",
      baseBranch: "main",
      remoteKind: "github" as const,
      repo: "agent",
      rootDirectory: "apps/agent",
    })),
    readConfig: vi.fn(async () => config),
    writeConfig,
  };
  return { client, complete, getConfig: () => config, operations, prompter, writeConfig };
}

describe("self-modification setup", () => {
  it.each([
    ["https://github.com/acme/agent.git", { owner: "acme", repo: "agent" }],
    ["git@github.com:acme/agent.git", { owner: "acme", repo: "agent" }],
    ["https://gitlab.com/acme/agent.git", undefined],
  ])("parses GitHub remote %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });

  it("recognizes only an unchanged generated review configuration", () => {
    const source = renderSelfModificationConfig(VALUES);
    expect(inspectSelfModificationConfig(source)).toEqual({
      kind: "review",
      values: VALUES,
    });
    expect(source).toContain("source");
    expect(source).toContain("change");
    expect(inspectSelfModificationConfig(`${source}\n// authored change\n`)).toEqual({
      kind: "diverged",
    });
  });

  it("keeps non-interactive setup local-only", async () => {
    const harness = setupHarness({ config: DEVELOPMENT_CONFIG });
    await runSelfModificationSetup(harness.client, harness.operations, { yes: true });
    expect(harness.writeConfig).not.toHaveBeenCalled();
  });

  it("writes configuration for a Git-connected Vercel deployment", async () => {
    const harness = setupHarness({
      config: DEVELOPMENT_CONFIG,
      selections: {
        "Configure draft pull requests for which environment?": "vercel",
        "Write this self-modification configuration?": "yes",
      },
      texts: {
        "GitHub repository name": "agent",
        "GitHub repository owner": "acme",
        "Pull request base branch": "main",
      },
    });
    await runSelfModificationSetup(harness.client, harness.operations);
    expect(inspectSelfModificationConfig(harness.getConfig())).toEqual({
      kind: "review",
      values: VALUES,
    });
    expect(harness.getConfig()).not.toContain("EVE_SELF_MODIFICATION_GITHUB_TOKEN");
    expect(harness.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("non-Git-connected CLI deployment"),
      "Vercel deployment requirements",
    );
    expect(harness.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Every session accepted"),
      "Pull request boundaries",
    );
    expect(harness.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentRequired: true,
        facts: expect.arrayContaining([{ label: "Deployment", value: "Git-connected Vercel" }]),
      }),
    );
  });

  it("guides manual CI and self-hosted prerequisites", async () => {
    const harness = setupHarness({
      config: DEVELOPMENT_CONFIG,
      selections: {
        "Configure draft pull requests for which environment?": "manual",
        "Write this self-modification configuration?": "yes",
      },
      texts: {
        "GitHub repository name": "agent",
        "GitHub repository owner": "acme",
        "Pull request base branch": "main",
      },
    });

    await runSelfModificationSetup(harness.client, harness.operations);

    expect(harness.prompter.note).toHaveBeenCalledWith(
      expect.stringMatching(
        /EVE_SOURCE_REPOSITORY=github\.com\/acme\/agent[\s\S]*EVE_SOURCE_REVISION=<trusted-ci-commit-sha>[\s\S]*EVE_SOURCE_ROOT=apps\/agent[\s\S]*process-capable/u,
      ),
      "Manual deployment requirements",
    );
    expect(harness.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentRequired: true,
        facts: expect.arrayContaining([{ label: "Deployment", value: "manual prerequisites" }]),
      }),
    );
  });

  it("does not overwrite an authored configuration", async () => {
    const harness = setupHarness({
      config: "export const authored = true;\n",
      selections: {
        "Configure draft pull requests for which environment?": "vercel",
        "Write this self-modification configuration?": "yes",
      },
      texts: {
        "GitHub repository name": "agent",
        "GitHub repository owner": "acme",
        "Pull request base branch": "main",
      },
    });
    await runSelfModificationSetup(harness.client, harness.operations);
    expect(harness.writeConfig).not.toHaveBeenCalled();
    expect(harness.complete).toHaveBeenCalledWith({
      facts: [{ label: "Self-modification", value: "manual configuration update required" }],
    });
  });

  it("keeps an unchanged generated pull request configuration on rerun", async () => {
    const source = renderSelfModificationConfig(VALUES);
    const harness = setupHarness({ config: source });
    await runSelfModificationSetup(harness.client, harness.operations);
    expect(harness.getConfig()).toBe(source);
    expect(harness.writeConfig).not.toHaveBeenCalled();
  });
});
