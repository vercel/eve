import { afterEach, describe, expect, it, vi } from "vitest";

import type { Prompter } from "#setup/prompter.js";

import {
  runChannelsAddCompatibilityCommand,
  type ChannelsAddDependencies,
  type CliLogger,
} from "./channels.js";

const { isEveProject } = vi.hoisted(() => ({ isEveProject: vi.fn(async () => true) }));

vi.mock("#setup/scaffold/index.js", () => ({
  isEveProject,
  listAuthoredChannels: vi.fn(async () => []),
}));

function logger(): CliLogger & { errors: string[] } {
  const errors: string[] = [];
  return { errors, error: (message) => errors.push(message), log: () => {} };
}

function dependencies(overrides: Partial<ChannelsAddDependencies> = {}): ChannelsAddDependencies {
  return {
    createPrompter: vi.fn(() => ({}) as Prompter),
    loadAddCommand: vi.fn(async () => vi.fn(async () => {})),
    loadChannelsFlow: vi.fn(async () =>
      vi.fn(async () => ({ kind: "done" as const, addedChannels: [] })),
    ),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runChannelsAddCompatibilityCommand", () => {
  it("maps an explicit kind to the canonical registry item", async () => {
    const output = logger();
    const runAdd = vi.fn(async () => {});

    await runChannelsAddCompatibilityCommand(
      output,
      "/project",
      { kind: "slack", options: { force: true } },
      dependencies({ loadAddCommand: async () => runAdd }),
    );

    expect(runAdd).toHaveBeenCalledWith(output, "/project", "channel/slack", {
      overwrite: true,
    });
  });

  it("forwards --yes to registry setup", async () => {
    const output = logger();
    const runAdd = vi.fn(async () => {});

    await runChannelsAddCompatibilityCommand(
      output,
      "/project",
      { kind: "slack", options: { yes: true } },
      dependencies({ loadAddCommand: async () => runAdd }),
    );

    expect(runAdd).toHaveBeenCalledWith(output, "/project", "channel/slack", {
      yes: true,
    });
  });

  it.skipIf(!process.stdin.isTTY || !process.stdout.isTTY)(
    "retains the bare interactive picker as a compatibility surface",
    async () => {
      const output = logger();
      const runFlow = vi.fn(async () => ({ kind: "done" as const, addedChannels: [] }));
      const prompter = {} as Prompter;

      await runChannelsAddCompatibilityCommand(
        output,
        "/project",
        { options: {} },
        dependencies({ createPrompter: () => prompter, loadChannelsFlow: async () => runFlow }),
      );

      expect(runFlow).toHaveBeenCalledWith({ appRoot: "/project", prompter });
    },
  );

  it("rejects an unknown explicit kind", async () => {
    const output = logger();

    await runChannelsAddCompatibilityCommand(
      output,
      "/project",
      { kind: "unknown", options: {} },
      dependencies(),
    );

    expect(output.errors).toEqual(['Unknown channel kind "unknown". Known: slack, web.']);
    expect(process.exitCode).toBe(1);
  });
});
