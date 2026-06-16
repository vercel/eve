import { describe, expect, it } from "vitest";

import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";

describe("createWorkspacePromptSection", () => {
  it("tells the model not to answer from the overview when bash verification fails", () => {
    const section = createWorkspacePromptSection({
      rootEntries: ["skills", "weather-codes.md"],
    });

    expect(section).toContain(
      "If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
    );
  });
});
