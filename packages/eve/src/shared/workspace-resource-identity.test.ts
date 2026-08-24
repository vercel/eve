import { describe, expect, it } from "vitest";

import {
  hashWorkspaceResourceFiles,
  workspaceResourceLogicalPath,
} from "#shared/workspace-resource-identity.js";

describe("workspace resource identity", () => {
  it("derives one canonical compile-relative path per graph node", () => {
    expect(workspaceResourceLogicalPath("__root__")).toBe("workspace-resources/__root__");
    expect(workspaceResourceLogicalPath("subagents/research::subagents/review")).toBe(
      "workspace-resources/subagents/research::subagents/review",
    );
  });

  it.each(["", "/absolute", "../outside", "subagents/../outside", "subagents\\child"])(
    "rejects non-canonical node id %j",
    (nodeId) => {
      expect(() => workspaceResourceLogicalPath(nodeId)).toThrow(/normalized relative POSIX path/u);
    },
  );

  it("hashes logical paths and bytes independent of input order", () => {
    const files = [
      { content: Buffer.from("alpha"), logicalPath: "workspace/a.txt" },
      { content: Buffer.from("beta"), logicalPath: "skills/review/SKILL.md" },
    ];

    expect(hashWorkspaceResourceFiles(files)).toBe(
      hashWorkspaceResourceFiles([...files].reverse()),
    );
    expect(
      hashWorkspaceResourceFiles([
        { ...files[0]!, logicalPath: "workspace/renamed.txt" },
        files[1]!,
      ]),
    ).not.toBe(hashWorkspaceResourceFiles(files));
    expect(
      hashWorkspaceResourceFiles([{ ...files[0]!, content: Buffer.from("changed") }, files[1]!]),
    ).not.toBe(hashWorkspaceResourceFiles(files));
    expect(hashWorkspaceResourceFiles([])).toBeUndefined();
  });
});
