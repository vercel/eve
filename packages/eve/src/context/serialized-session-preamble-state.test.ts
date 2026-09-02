import { describe, expect, it } from "vitest";

import {
  DynamicSkillManifestKey,
  SessionDynamicInstructionsKey,
  SessionDynamicModelReferenceKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicSubagentSelectionsKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  TurnDynamicModelReferenceKey,
} from "#context/keys.js";
import { preserveSerializedSessionPreambleState } from "#context/serialized-session-preamble-state.js";

describe("preserveSerializedSessionPreambleState", () => {
  it("preserves every durable session.started output but not turn state", () => {
    const interrupted = {
      [SessionDynamicModelReferenceKey.name]: { id: "model" },
      [SessionDynamicToolMetadataKey.name]: [{ name: "tool" }],
      [SessionDynamicToolRuntimeRevisionKey.name]: "tools-revision",
      [SessionDynamicSubagentSelectionsKey.name]: { researcher: null },
      [SessionDynamicSubagentRuntimeRevisionKey.name]: "subagents-revision",
      [DynamicSkillManifestKey.name]: { skills: [{ name: "skill" }] },
      [SessionDynamicInstructionsKey.name]: {
        instructions: [{ content: "instruction", role: "system" }],
      },
      [TurnDynamicModelReferenceKey.name]: { id: "turn-model" },
    };

    const preserved = preserveSerializedSessionPreambleState({ original: true }, interrupted);

    for (const key of [
      SessionDynamicModelReferenceKey,
      SessionDynamicToolMetadataKey,
      SessionDynamicToolRuntimeRevisionKey,
      SessionDynamicSubagentSelectionsKey,
      SessionDynamicSubagentRuntimeRevisionKey,
      DynamicSkillManifestKey,
      SessionDynamicInstructionsKey,
    ]) {
      expect(preserved[key.name]).toEqual(interrupted[key.name]);
    }
    expect(preserved).not.toHaveProperty(TurnDynamicModelReferenceKey.name);
    expect(preserved.original).toBe(true);
  });
});
