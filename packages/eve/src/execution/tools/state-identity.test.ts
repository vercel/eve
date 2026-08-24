import { describe, expect, it } from "vitest";

import { DynamicSkillManifestKey } from "#context/keys.js";
import { AuthoredSkillsKey } from "#context/providers/skill-key.js";
import { ConnectionSearchResultsKey } from "#execution/tools/connection-search.js";
import { ReadFileStateKey } from "#execution/tools/file-state.js";
import { TodoStateKey } from "#execution/tools/todo.js";

describe("ordinary primitive durable state identity", () => {
  it("keeps the persisted context key names stable", () => {
    expect(AuthoredSkillsKey.name).toBe("eve.authoredSkills");
    expect(ConnectionSearchResultsKey.name).toBe("eve.connectionSearchResults");
    expect(DynamicSkillManifestKey.name).toBe("eve.dynamicSkillManifest");
    expect(ReadFileStateKey.name).toBe("eve.readFile");
    expect(TodoStateKey.name).toBe("eve.todo");
  });
});
