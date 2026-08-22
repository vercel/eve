import { describe, expect, it, vi } from "vitest";

import { createFakePrompter, type FakePrompterConfig } from "#internal/testing/fake-prompter.js";

import { confirmInitInNonEmptyDirectory, type InitConfirmDependencies } from "./init-confirm.js";

function dependencies(input: {
  interactive: boolean;
  onSelect?: FakePrompterConfig["single"];
  onText?: FakePrompterConfig["text"];
}): InitConfirmDependencies {
  const fake = createFakePrompter({ single: input.onSelect, text: input.onText });
  return {
    createPrompter: vi.fn(() => fake.prompter),
    hasInteractiveTerminal: vi.fn(() => input.interactive),
  };
}

describe("confirmInitInNonEmptyDirectory", () => {
  it("selects the current directory with an overwrite warning", async () => {
    const deps = dependencies({
      interactive: true,
      onSelect: (options) => {
        expect(options).toMatchObject({
          message: "Where should eve initialize the project?",
          description:
            "The current directory isn't empty. Found: README.md, src, notes.txt, draft.md, data.json, and 1 more.",
          initialValue: "subdirectory",
        });
        expect(options.options).toEqual([
          {
            value: "subdirectory",
            label: "Create a new subdirectory",
            hint: "Keep the current directory unchanged",
          },
          {
            value: "current-directory",
            label: "Use the current directory",
            hint: "Overwrite files at generated paths",
            accent: "warning",
          },
        ]);
        return "current-directory";
      },
    });

    await expect(
      confirmInitInNonEmptyDirectory(
        ["README.md", "src", "notes.txt", "draft.md", "data.json", "archive"],
        deps,
      ),
    ).resolves.toEqual({ kind: "current-directory" });
  });

  it("asks for and normalizes a new subdirectory name", async () => {
    const deps = dependencies({
      interactive: true,
      onSelect: () => "subdirectory",
      onText: (options) => {
        expect(options).toMatchObject({
          message: "Subdirectory name",
          defaultValue: "my-agent",
        });
        expect(options.validate?.("../escape")).toBeDefined();
        return "  research-agent  ";
      },
    });

    await expect(confirmInitInNonEmptyDirectory(["README.md"], deps)).resolves.toEqual({
      kind: "subdirectory",
      name: "research-agent",
    });
  });

  it("refuses a non-interactive scaffold instead of opening a prompt", async () => {
    const deps = dependencies({ interactive: false });

    await expect(confirmInitInNonEmptyDirectory(["README.md"], deps)).rejects.toThrow(
      "Cannot choose where to initialize the non-empty current directory without an interactive terminal. Found: README.md. Pass a new directory name, for example: eve init my-agent.",
    );
    expect(deps.createPrompter).not.toHaveBeenCalled();
  });
});
