import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());

vi.mock("eve/context", () => ({
  defineState<T>(name: string, initial: () => T) {
    return {
      get() {
        if (!state.has(name)) state.set(name, initial());
        return state.get(name) as T;
      },
      update(update: (current: T) => T) {
        if (!state.has(name)) state.set(name, initial());
        state.set(name, update(state.get(name) as T));
      },
    };
  },
}));

import finalizeEditsTool from "../extension/tools/finalize_edits.js";
import { finalizeEdits, proposeEdits, requireProposalApproval } from "../extension/lib/edits.js";

function createSandbox(initial: Readonly<Record<string, string>>) {
  const files = new Map(Object.entries(initial));
  const writeTextFile = vi.fn(async ({ content, path }: { content: string; path: string }) => {
    files.set(path, content);
  });
  const removePath = vi.fn(async ({ path }: { path: string }) => {
    files.delete(path);
  });
  const sandbox = {
    readTextFile: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    removePath,
    writeTextFile,
  };
  return { files, removePath, sandbox, writeTextFile };
}

beforeEach(() => state.clear());

describe("selfmod edits", () => {
  it("wires the framework approval gate to the only source-writing tool", () => {
    expect(finalizeEditsTool.approval).toBe(requireProposalApproval);
  });

  it("records without writing and applies the exact proposal after approval", async () => {
    const { files, removePath, sandbox, writeTextFile } = createSandbox({
      "/source/agent.ts": "model: 'old'\n",
      "/source/obsolete.md": "remove me\n",
    });
    const proposal = await proposeEdits(sandbox, {
      edits: [
        {
          filePath: "/source/agent.ts",
          kind: "replace",
          newText: "model: 'new'",
          oldText: "model: 'old'",
        },
        { content: "hello\n", filePath: "/source/new.md", kind: "create" },
        { filePath: "/source/obsolete.md", kind: "delete" },
      ],
      summary: "Update source files.",
    });

    expect(writeTextFile).not.toHaveBeenCalled();
    expect(removePath).not.toHaveBeenCalled();
    expect(
      requireProposalApproval({ toolInput: proposal } as Parameters<
        typeof requireProposalApproval
      >[0]),
    ).toEqual({
      type: "user-approval",
      content: {
        type: "text",
        text: [
          "--- /source/agent.ts",
          "+++ /source/agent.ts",
          "- model: 'old'",
          "+ model: 'new'",
          "",
          "--- /dev/null",
          "+++ /source/new.md",
          "+ hello",
          "",
          "--- /source/obsolete.md",
          "+++ /dev/null",
          "- remove me",
        ].join("\n"),
      },
    });

    await finalizeEdits(sandbox, proposal.proposalId);

    expect(files.get("/source/agent.ts")).toBe("model: 'new'\n");
    expect(files.get("/source/new.md")).toBe("hello\n");
    expect(files.has("/source/obsolete.md")).toBe(false);
  });

  it("rejects paths outside source and files changed while approval was pending", async () => {
    const { files, sandbox } = createSandbox({ "/source/a.ts": "old\n" });

    await expect(
      proposeEdits(sandbox, {
        edits: [{ content: "nope", filePath: "/workspace/a.ts", kind: "create" }],
        summary: "Escape source.",
      }),
    ).rejects.toThrow("must be under /source");

    const proposal = await proposeEdits(sandbox, {
      edits: [{ filePath: "/source/a.ts", kind: "replace", newText: "new", oldText: "old" }],
      summary: "Change a.ts.",
    });
    files.set("/source/a.ts", "external change\n");

    await expect(finalizeEdits(sandbox, proposal.proposalId)).rejects.toThrow(
      "changed after the edits were proposed",
    );
  });

  it("restores earlier files when applying a later edit fails", async () => {
    const { files, sandbox, writeTextFile } = createSandbox({
      "/source/a.ts": "old a\n",
      "/source/b.ts": "old b\n",
    });
    const proposal = await proposeEdits(sandbox, {
      edits: [
        { filePath: "/source/a.ts", kind: "replace", newText: "new a", oldText: "old a" },
        { filePath: "/source/b.ts", kind: "replace", newText: "new b", oldText: "old b" },
      ],
      summary: "Update both files.",
    });
    writeTextFile
      .mockImplementationOnce(async ({ content, path }) => {
        files.set(path, content);
      })
      .mockRejectedValueOnce(new Error("disk full"));

    await expect(finalizeEdits(sandbox, proposal.proposalId)).rejects.toThrow("disk full");

    expect(files.get("/source/a.ts")).toBe("old a\n");
    expect(files.get("/source/b.ts")).toBe("old b\n");
  });

  it("denies unknown proposals before requesting user approval", () => {
    expect(
      requireProposalApproval({
        toolInput: { proposalId: "00000000-0000-4000-8000-000000000000" },
      } as Parameters<typeof requireProposalApproval>[0]),
    ).toEqual({
      reason: expect.stringContaining("Unknown or expired"),
      type: "denied",
    });
  });
});
