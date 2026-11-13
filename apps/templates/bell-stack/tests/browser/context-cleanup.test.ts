import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), create: vi.fn(), fetch: vi.fn() }));
vi.mock("@browserbasehq/sdk", () => {
  class APIError extends Error {
    constructor(readonly status: number) { super("Synthetic provider failure"); }
  }
  return { default: class {
    static APIError = APIError;
    contexts = { retrieve: mocks.retrieve, create: mocks.create };
  } };
});

import Browserbase from "@browserbasehq/sdk";
import { ensureAgentContext } from "../../server/browser/agent-contexts";
import * as metadata from "../../server/browser/context-metadata-store";

let directory: string;
let store: metadata.ContextMetadataStore;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("BROWSERBASE_API_KEY", "synthetic-only");
  vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
  vi.stubGlobal("fetch", mocks.fetch);
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-context-cleanup-"));
  store = new metadata.ContextMetadataStore(path.join(directory, "contexts.json"));
  vi.spyOn(metadata, "getContextMetadataStore").mockReturnValue(store);
  mocks.create.mockResolvedValue({ id: "new_context" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("remote Context cleanup", () => {
  it("keeps an expired current Context tracked when remote deletion fails", async () => {
    await store.addDraft("old_context", "Old", "session_one", new Date(0));
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(ensureAgentContext("session_one", "old_context")).rejects.toThrow("cleanup failed");
    expect((await store.read()).contexts.old_context).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("retains other failed cleanup records while creating a new draft", async () => {
    await store.addDraft("old_context", "Old", "session_old", new Date(0));
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(ensureAgentContext("session_new")).resolves.toMatchObject({ id: "new_context" });
    expect(Object.keys((await store.read()).contexts).sort()).toEqual(["new_context", "old_context"]);
  });

  it("preserves a draft through a temporary retrieval failure", async () => {
    await store.addDraft("old_context", "Old", "session_one", new Date(Date.now() + 60_000));
    mocks.retrieve.mockRejectedValue(new Browserbase.APIError(503, undefined, "unavailable", undefined));
    await expect(ensureAgentContext("session_one", "old_context")).rejects.toThrow("Synthetic provider failure");
    expect((await store.read()).contexts.old_context).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("replaces a draft only after retrieval confirms it no longer exists", async () => {
    await store.addDraft("old_context", "Old", "session_one", new Date(Date.now() + 60_000));
    mocks.retrieve.mockRejectedValue(new Browserbase.APIError(404, undefined, "missing", undefined));
    await expect(ensureAgentContext("session_one", "old_context")).resolves.toMatchObject({ id: "new_context" });
    expect(Object.keys((await store.read()).contexts)).toEqual(["new_context"]);
  });

  it.each([204, 404])("forgets expired Context metadata after deletion returns %s", async status => {
    await store.addDraft("old_context", "Old", "session_one", new Date(0));
    mocks.fetch.mockResolvedValue(new Response(null, { status }));
    await ensureAgentContext("session_one", "old_context");
    expect(Object.keys((await store.read()).contexts)).toEqual(["new_context"]);
  });
});
