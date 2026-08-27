import { createHash } from "node:crypto";

import type { SandboxNetworkPolicy } from "eve/sandbox";
import { describe, expect, it } from "vitest";

import {
  captureSelfModificationProposal,
  parseRawDiff,
  prepareSelfModificationWorkspace,
  readProposalBlob,
  type PreparedSelfModificationWorkspace,
  type ProposalChange,
  type SelfModificationCheckoutSandbox,
} from "./git-workspace.js";

const DEPLOYED_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const TREE_SHA = "3".repeat(40);
const BASE_TREE_SHA = "4".repeat(40);
const BLOB_SHA = "6".repeat(40);
const workspace: PreparedSelfModificationWorkspace = {
  baseSha: BASE_SHA,
  deployedPath: "/workspace/self-modification/deployed",
  deployedSha: DEPLOYED_SHA,
  repositoryPath: "/workspace/self-modification/repository",
  rootDirectory: ".",
};

function createSandbox(
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({}),
) {
  const commands: string[] = [];
  const policies: Array<SandboxNetworkPolicy | "allow-all" | "deny-all"> = [];
  const sandbox: SelfModificationCheckoutSandbox = {
    async run({ command }: { command: string }) {
      commands.push(command);
      return { exitCode: 0, stderr: "", stdout: "", ...respond(command) };
    },
    async setNetworkPolicy(policy: SandboxNetworkPolicy | "allow-all" | "deny-all") {
      policies.push(policy);
    },
  };
  return { commands, policies, sandbox };
}

describe("prepareSelfModificationWorkspace", () => {
  it("fetches through brokered credentials and leaves the sandbox offline", async () => {
    const token = "secret-read-token";
    const { commands, policies, sandbox } = createSandbox((command) =>
      command.includes("rev-parse refs/eve-self-modification/base")
        ? { stdout: `${BASE_SHA}\n` }
        : command.includes("rev-parse refs/eve-self-modification/deployed")
          ? { stdout: `${DEPLOYED_SHA}\n` }
          : {},
    );

    await expect(
      prepareSelfModificationWorkspace({
        deployedSha: DEPLOYED_SHA,
        token: token,
        repository: { owner: "acme", targetBranch: "main", repo: "agent" },
        rootDirectory: ".",
        sandbox,
      }),
    ).resolves.toEqual(workspace);

    expect(commands.join("\n")).not.toContain(token);
    expect(commands.join("\n")).toContain("https://github.com/acme/agent.git");
    expect(commands.join("\n")).toContain(`fetch --no-tags --depth=50 origin '${DEPLOYED_SHA}'`);
    expect(commands.join("\n")).toContain("refs/heads/main");
    expect(policies).toHaveLength(2);
    expect(policies[1]).toBe("deny-all");
  });

  it("removes brokered credentials when checkout fails", async () => {
    const { policies, sandbox } = createSandbox((command) =>
      command.includes(" fetch ") ? { exitCode: 1, stderr: "fetch failed" } : {},
    );
    await expect(
      prepareSelfModificationWorkspace({
        deployedSha: DEPLOYED_SHA,
        token: "token",
        repository: { owner: "acme", targetBranch: "main", repo: "agent" },
        rootDirectory: ".",
        sandbox,
      }),
    ).rejects.toThrow(/fetch failed/u);
    expect(policies.at(-1)).toBe("deny-all");
  });

  it("rejects unsafe branch names before opening the sandbox network", async () => {
    const { policies, sandbox } = createSandbox();
    await expect(
      prepareSelfModificationWorkspace({
        deployedSha: DEPLOYED_SHA,
        token: "token",
        repository: { owner: "acme", targetBranch: "main; curl bad", repo: "agent" },
        rootDirectory: ".",
        sandbox,
      }),
    ).rejects.toThrow(/valid Git ref/u);
    expect(policies).toEqual([]);
  });
});

describe("captureSelfModificationProposal", () => {
  it("captures an immutable tree and returns a Git-object manifest", async () => {
    const raw = [
      `:100644 100644 ${"7".repeat(40)} ${BLOB_SHA} M`,
      "agent/instructions.md",
      `:100644 000000 ${"8".repeat(40)} ${"0".repeat(40)} D`,
      "agent/old.md",
      "",
    ].join("\0");
    const { commands, sandbox } = createSandbox((command) => {
      if (command.endsWith("write-tree")) return { stdout: TREE_SHA };
      if (command.includes("^{tree}")) return { stdout: BASE_TREE_SHA };
      if (command.includes("diff-tree")) return { stdout: raw };
      if (command.includes("cat-file -s")) return { stdout: "42" };
      return {};
    });

    await expect(captureSelfModificationProposal({ sandbox, workspace })).resolves.toEqual({
      baseSha: BASE_SHA,
      baseTreeSha: BASE_TREE_SHA,
      changedBytes: 42,
      changes: [
        {
          bytes: 42,
          kind: "modify",
          mode: "100644",
          objectId: BLOB_SHA,
          path: "agent/instructions.md",
        },
        { bytes: 0, kind: "delete", mode: null, objectId: null, path: "agent/old.md" },
      ],
      proposedTreeSha: TREE_SHA,
    });
    expect(commands.join("\n")).toContain(`read-tree '${BASE_SHA}'`);
    expect(commands.join("\n")).toContain("add -A -- .");
    expect(commands.join("\n")).not.toContain("commit-tree");
    expect(commands.join("\n")).toContain("diff-tree -r --no-commit-id --raw -z --no-renames");
  });

  it("rejects unsupported file modes", async () => {
    const raw = [`:100644 120000 ${"7".repeat(40)} ${BLOB_SHA} T`, "agent/link", ""].join("\0");
    const { sandbox } = createSandbox((command) => {
      if (command.endsWith("write-tree")) return { stdout: TREE_SHA };
      if (command.includes("^{tree}")) return { stdout: BASE_TREE_SHA };
      if (command.includes("diff-tree")) return { stdout: raw };
      return {};
    });

    await expect(captureSelfModificationProposal({ sandbox, workspace })).rejects.toThrow(
      /unsupported Git mode 120000/u,
    );
  });

  it.each([
    ["outside the fixed agent source scope", "package.json"],
    [
      "the protected self-modification configuration",
      "agent/subagents/self-modification/config.ts",
    ],
  ])("rejects changes %s", async (_description, path) => {
    const raw = [
      `:100644 100644 ${"7".repeat(40)} ${BLOB_SHA} M`,
      "agent/instructions.md",
      `:100644 100644 ${"8".repeat(40)} ${BLOB_SHA} M`,
      path,
      "",
    ].join("\0");
    const { sandbox } = createSandbox((command) => {
      if (command.endsWith("write-tree")) return { stdout: TREE_SHA };
      if (command.includes("^{tree}")) return { stdout: BASE_TREE_SHA };
      if (command.includes("diff-tree")) return { stdout: raw };
      return {};
    });

    await expect(captureSelfModificationProposal({ sandbox, workspace })).rejects.toThrow(
      new RegExp(`policy-excluded changes: .*${path.replaceAll("/", "\\/")}`, "u"),
    );
  });

  it("uses the deployment root to scope changes", async () => {
    const raw = [
      `:100644 100644 ${"7".repeat(40)} ${BLOB_SHA} M`,
      "apps/weather/agent/agent.ts",
      "",
    ].join("\0");
    const { sandbox } = createSandbox((command) => {
      if (command.endsWith("write-tree")) return { stdout: TREE_SHA };
      if (command.includes("^{tree}")) return { stdout: BASE_TREE_SHA };
      if (command.includes("diff-tree")) return { stdout: raw };
      if (command.includes("cat-file -s")) return { stdout: "42" };
      return {};
    });

    await expect(
      captureSelfModificationProposal({
        sandbox,
        workspace: { ...workspace, rootDirectory: "apps/weather" },
      }),
    ).resolves.toMatchObject({ changes: [{ path: "apps/weather/agent/agent.ts" }] });
  });
});

describe("parseRawDiff", () => {
  it("rejects malformed and rename output", () => {
    expect(() => parseRawDiff(":bad\0agent/a.ts\0")).toThrow(/malformed/u);
    expect(() =>
      parseRawDiff(
        `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} R100\0agent/a.ts\0agent/b.ts\0`,
      ),
    ).toThrow(/malformed/u);
  });
});

describe("readProposalBlob", () => {
  const content = "hello";
  const objectId = createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
  const change: ProposalChange = {
    bytes: Buffer.byteLength(content),
    kind: "modify",
    mode: "100644",
    objectId,
    path: "agent/instructions.md",
  };

  it("returns base64 content that hashes back to the captured object id", async () => {
    const { commands, sandbox } = createSandbox(() => ({
      stdout: Buffer.from(content).toString("base64"),
    }));

    await expect(readProposalBlob({ change, sandbox, workspace })).resolves.toBe(
      Buffer.from(content).toString("base64"),
    );
    expect(commands.join("\n")).toContain(`cat-file blob '${objectId}'`);
  });

  it("rejects content the sandbox substituted for the captured object", async () => {
    const { sandbox } = createSandbox(() => ({
      stdout: Buffer.from("hellp").toString("base64"),
    }));

    await expect(readProposalBlob({ change, sandbox, workspace })).rejects.toThrow(
      /changed after validation/u,
    );
  });

  it("rejects truncated sandbox output", async () => {
    const { sandbox } = createSandbox(() => ({ stdout: Buffer.from("hel").toString("base64") }));

    await expect(readProposalBlob({ change, sandbox, workspace })).rejects.toThrow(
      /changed after validation/u,
    );
  });
});
