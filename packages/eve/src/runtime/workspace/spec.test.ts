import { describe, expect, it } from "vitest";

import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";

describe("createWorkspacePromptSection", () => {
  it("advertises the shared workspace root", () => {
    const section = createWorkspacePromptSection({ rootEntries: ["weather-codes.md"] });

    expect(section).toContain("`/workspace`");
    expect(section).toContain("Root entries under /workspace/");
    expect(section).not.toContain("private to you");
  });

  it("advertises a private seeded root for a homed subagent", () => {
    const section = createWorkspacePromptSection(
      { rootEntries: ["weather-codes.md"] },
      "$HOME/workspace",
    );

    expect(section).toContain("mounted at `$HOME/workspace`");
    expect(section).toContain("Root entries under $HOME/workspace/");
    expect(section).toContain("`$HOME/workspace` is private to you");
    expect(section).toContain(
      "The live workspace root visible to `bash` in this run is `/workspace`",
    );
  });

  it("tells the model not to answer from the overview when bash verification fails", () => {
    const section = createWorkspacePromptSection({
      rootEntries: ["weather-codes.md"],
    });

    expect(section).toContain(
      "If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
    );
  });
});
