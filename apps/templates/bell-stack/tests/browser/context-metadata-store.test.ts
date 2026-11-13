import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMetadataStore } from "../../server/browser/context-metadata-store";

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-context-metadata-"));
  filePath = path.join(directory, "contexts.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("browser context metadata", () => {
  it("preserves concurrent additions across store instances and equivalent paths", async () => {
    const stores = [
      new ContextMetadataStore(filePath),
      new ContextMetadataStore(path.relative(process.cwd(), filePath)),
    ];
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      stores[index % stores.length].add(`context_${index}`, `Context ${index}`),
    ));

    const value = await stores[0].read();
    expect(Object.keys(value.contexts)).toEqual(Array.from({ length: 8 }, (_, index) => `context_${index}`));
    expect(value.selectedContextId).toBe("context_0");
    expect(await readdir(directory)).toEqual(["contexts.json"]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("serializes draft promotion, renewal, selection, and removal with other writes", async () => {
    const first = new ContextMetadataStore(filePath);
    const second = new ContextMetadataStore(filePath);
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    await first.add("context_old", "Old");
    await first.addDraft("context_saved", "Draft", "session_one", expiresAt);
    await first.addDraft("context_draft", "Draft", "session_two", expiresAt);
    const renewedAt = new Date("2026-12-02T00:00:00.000Z");

    await Promise.all([
      first.remove("context_old"),
      second.promote("context_saved", "Saved"),
      first.add("context_new", "New"),
      second.touchDraft("context_draft", renewedAt),
      first.select("context_saved"),
    ]);

    const value = await second.read();
    expect(Object.keys(value.contexts).sort()).toEqual(["context_draft", "context_new", "context_saved"]);
    expect(value.selectedContextId).toBe("context_saved");
    expect(value.contexts.context_saved).toMatchObject({ name: "Saved", status: "saved" });
    expect(value.contexts.context_saved).not.toHaveProperty("ownerSessionId");
    expect(value.contexts.context_saved).not.toHaveProperty("expiresAt");
    expect(value.contexts.context_draft.expiresAt).toBe(renewedAt.toISOString());
  });

  it("allows the next queued mutation to proceed after a failed mutation", async () => {
    const store = new ContextMetadataStore(filePath);
    const results = await Promise.allSettled([
      store.select("context_missing"),
      store.add("context_new", "New"),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect((await store.read()).contexts.context_new.name).toBe("New");
  });

  it.each([
    "{broken",
    JSON.stringify({}),
    JSON.stringify({ contexts: [] }),
    JSON.stringify({ contexts: { context_broken: null } }),
    JSON.stringify({ contexts: { context_broken: { name: "Broken", createdAt: "bad", updatedAt: "bad" } } }),
  ])("refuses to overwrite invalid existing data: %s", async (contents) => {
    await writeFile(filePath, contents);
    const store = new ContextMetadataStore(filePath);
    await expect(store.read()).rejects.toThrow("metadata is invalid");
    await expect(store.add("context_new", "New")).rejects.toThrow("metadata is invalid");
    expect(await readFile(filePath, "utf8")).toBe(contents);
    expect(await readdir(directory)).toEqual(["contexts.json"]);
  });

  it("propagates filesystem read errors instead of treating them as an empty store", async () => {
    await mkdir(filePath);
    const store = new ContextMetadataStore(filePath);
    await expect(store.read()).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.add("context_new", "New")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("removes its temporary file when the atomic replacement fails", async () => {
    const store = new ContextMetadataStore(filePath);
    vi.spyOn(store, "read").mockImplementationOnce(async () => {
      // Simulate another filesystem operation blocking replacement after the read.
      await mkdir(filePath);
      return { contexts: {} };
    });
    await expect(store.add("context_new", "New")).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["contexts.json"]);

    await rm(filePath, { recursive: true });
    await store.add("context_new", "New");
    expect((await store.read()).contexts.context_new.name).toBe("New");
  });

  it("reads the existing metadata format, including saved contexts without status", async () => {
    const value = {
      selectedContextId: "context_legacy",
      contexts: {
        context_legacy: {
          name: "Existing login",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    };
    await writeFile(filePath, JSON.stringify(value));
    expect(await new ContextMetadataStore(filePath).read()).toEqual(value);
  });
});
