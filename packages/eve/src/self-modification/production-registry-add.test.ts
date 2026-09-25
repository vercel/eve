import { describe, expect, it } from "vitest";

import {
  acceptsNonSecretSetupAnswers,
  assertOfficialRegistryAddress,
  installProductionRegistryItem,
} from "./extension/production-registry-add.js";

const SHA = "a".repeat(40);
const workspace = {
  baseSha: SHA,
  directory: ".",
  repository: { owner: "acme", repo: "agent" },
  repositoryPath: "/repository",
  targetBranch: "main",
} as const;

describe("production registry addresses", () => {
  it("accepts canonical official addresses", () => {
    for (const address of ["channel/slack", "extension/browserbase", "linear"]) {
      expect(() => assertOfficialRegistryAddress(address)).not.toThrow();
    }
  });

  it("does not change network policy or forward an environment answer", async () => {
    const commands: string[] = [];
    let networkPolicyUpdates = 0;
    const result = await installProductionRegistryItem({
      address: "channel/slack",
      answers: { SLACK_BOT_TOKEN: "secret" },
      installed: true,
      sandbox: {
        run: async ({ command }: { readonly command: string }) => {
          commands.push(command);
          if (command.includes("while :")) return { exitCode: 0, stdout: "pnpm\t/repository" };
          if (command.includes("info/exclude") || command.includes("corepack")) {
            return { exitCode: 0 };
          }
          if (command.includes("for executable")) {
            return { exitCode: 0, stdout: "/repository/node_modules/.bin/eve" };
          }
          if (
            command.includes(" add -A") ||
            command.includes("read-tree") ||
            command.includes(" clean -fd -- .")
          ) {
            return { exitCode: 0 };
          }
          if (command.includes("write-tree")) return { exitCode: 0, stdout: SHA };
          if (command.includes("--skip-install")) {
            return {
              exitCode: 2,
              stderr: JSON.stringify({
                version: 1,
                type: "blocked",
                item: "channel/slack",
                installed: true,
                question: { key: "SLACK_BOT_TOKEN", kind: "environment", sensitive: true },
              }),
            };
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        setNetworkPolicy: async () => {
          networkPolicyUpdates += 1;
        },
      } as never,
      workspace,
    });

    expect(result).toMatchObject({ kind: "input-required", installed: true });
    expect(commands.join("\n")).not.toContain("SLACK_BOT_TOKEN=secret");
    expect(networkPolicyUpdates).toBe(0);
  });

  it("removes files created by a failed install while restoring the starting tree", async () => {
    const commands: string[] = [];
    const result = await installProductionRegistryItem({
      address: "extension/browserbase",
      sandbox: {
        run: async ({ command }: { readonly command: string }) => {
          commands.push(command);
          if (command.includes("while :")) return { exitCode: 0, stdout: "pnpm\t/repository" };
          if (command.includes("info/exclude") || command.includes("corepack")) {
            return { exitCode: 0 };
          }
          if (command.includes("for executable")) {
            return { exitCode: 0, stdout: "/repository/node_modules/.bin/eve" };
          }
          if (command.includes(" add -A") || command.includes("read-tree")) {
            return { exitCode: 0 };
          }
          if (command.includes("write-tree")) return { exitCode: 0, stdout: SHA };
          if (command.includes(" clean -fd -- .")) return { exitCode: 0 };
          if (command.includes(" add ")) {
            return {
              exitCode: 1,
              stderr: JSON.stringify({
                version: 1,
                type: "failed",
                item: "extension/browserbase",
              }),
            };
          }
          throw new Error(`Unexpected command: ${command}`);
        },
        setNetworkPolicy: async () => {},
      } as never,
      workspace,
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(commands.some((command) => command.includes("read-tree --reset -u"))).toBe(true);
    expect(commands.some((command) => command.includes("clean -fd -- ."))).toBe(true);
  });

  it("accepts only the current non-secret setup answer", () => {
    expect(
      acceptsNonSecretSetupAnswers(
        { key: "components", kind: "multi-select" },
        {
          components: ["slack"],
        },
      ),
    ).toBe(true);
    expect(
      acceptsNonSecretSetupAnswers({ key: "API_KEY", kind: "environment" }, { API_KEY: "secret" }),
    ).toBe(false);
    expect(
      acceptsNonSecretSetupAnswers(
        { key: "components", kind: "multi-select" },
        { components: [], API_KEY: "secret" },
      ),
    ).toBe(false);
  });

  it("rejects URLs, configured namespaces, and shell-shaped input", () => {
    for (const address of [
      "https://example.com/item.json",
      "@acme/widget",
      "channel/slack; touch owned",
      "channel/slack --skip-setup",
      "../channel/slack",
    ]) {
      expect(() => assertOfficialRegistryAddress(address)).toThrow("exact official");
    }
  });
});
