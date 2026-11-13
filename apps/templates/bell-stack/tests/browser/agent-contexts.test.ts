import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listAgentContexts, promoteAgentContext } from "../../server/browser/agent-contexts";
import * as metadataStore from "../../server/browser/context-metadata-store";

vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    contexts = { retrieve: async (id: string) => ({ id }) };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("saved browser contexts", () => {
  it("keeps drafts hidden until the same context is promoted", async () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "synthetic-test-key");
    vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
    const directory = await mkdtemp(path.join(os.tmpdir(), "bell-context-test-"));
    const metadata = new metadataStore.ContextMetadataStore(path.join(directory, "contexts.json"));
    vi.spyOn(metadataStore, "getContextMetadataStore").mockReturnValue(metadata);
    try {
      await metadata.add("context_fixture", "Saved login");
      await metadata.addDraft(
        "context_draft",
        "Draft fixture",
        "session_fixture",
        new Date("2026-09-25T00:00:00.000Z"),
        new Date("2026-09-18T00:00:00.000Z"),
      );
      expect((await listAgentContexts()).map(({ id }) => id)).toEqual(["context_fixture"]);

      await promoteAgentContext("context_draft", "Hacker News");
      expect(await listAgentContexts()).toContainEqual(expect.objectContaining({
        id: "context_draft", name: "Hacker News", status: "saved", selected: true,
      }));
      const state = await metadata.read();
      expect(state.contexts.context_draft.ownerSessionId).toBeUndefined();
      expect(state.contexts.context_draft.expiresAt).toBeUndefined();
      expect(state.selectedContextId).toBe("context_draft");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
