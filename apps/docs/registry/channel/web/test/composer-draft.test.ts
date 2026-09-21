import assert from "node:assert/strict";
import { test } from "node:test";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import {
  createDraftStorage,
  createDraftDocument,
  draftScope,
  parseDraft,
} from "../lib/composer-draft.ts";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
function setup() {
  const disk = new MemoryStorage(),
    tab = new MemoryStorage();
  const storage = createDraftStorage(disk, tab, "page-1");
  const scope = draftScope("owner", "chat");
  return { disk, tab, storage, scope, draft: createDraftDocument(storage, scope) };
}
function type(draft: ReturnType<typeof createDraftDocument>, text: string) {
  draft.update(
    draft.state.update({
      changes: { from: draft.state.doc.length, insert: text },
      annotations: isolateHistory.of("full"),
    }).state,
  );
}
function command(draft: ReturnType<typeof createDraftDocument>, fn: typeof undo) {
  return fn({ state: draft.state, dispatch: (transaction) => draft.update(transaction.state) });
}

test("reload restores text, selection, undo and redo history", () => {
  const { draft, storage, scope } = setup();
  type(draft, "first");
  type(draft, " second");
  draft.update(draft.state.update({ selection: { anchor: 2, head: 7 } }).state);
  assert.equal(draft.flush(), true);
  const restored = createDraftDocument(storage, scope);
  assert.equal(restored.state.doc.toString(), "first second");
  assert.deepEqual(
    [restored.state.selection.main.anchor, restored.state.selection.main.head],
    [2, 7],
  );
  assert.equal(command(restored, undo), true);
  assert.equal(restored.state.doc.toString(), "first");
  restored.flush();
  const reloadedAgain = createDraftDocument(storage, scope);
  assert.equal(command(reloadedAgain, redo), true);
  assert.equal(reloadedAgain.state.doc.toString(), "first second");
});
test("only an acknowledged unchanged draft clears, and clearing remains undoable", () => {
  const { draft } = setup();
  type(draft, "send me");
  const submission = draft.capture();
  assert.ok(draft.acknowledge(submission));
  assert.equal(draft.state.doc.toString(), "");
  command(draft, undo);
  assert.equal(draft.state.doc.toString(), "send me");
  const second = draft.capture();
  type(draft, " with new edits");
  assert.equal(draft.acknowledge(second), undefined);
  assert.equal(draft.state.doc.toString(), "send me with new edits");
});
test("failed sends and late acknowledgments cannot erase another chat's draft", () => {
  const { draft, storage, scope } = setup();
  type(draft, "retry me");
  draft.capture();
  draft.flush();
  assert.equal(createDraftDocument(storage, scope).state.doc.toString(), "retry me");
  const other = createDraftDocument(storage, draftScope("owner", "other"));
  type(other, "other draft");
  other.flush();
  draft.acknowledge(draft.capture());
  draft.flush();
  assert.equal(
    createDraftDocument(storage, draftScope("owner", "other")).state.doc.toString(),
    "other draft",
  );
});
test("users, sessions, and concurrent browser tabs have independent drafts", () => {
  const { disk, tab, draft, scope } = setup();
  type(draft, "shared starting point");
  draft.flush();
  const duplicateTab = new MemoryStorage();
  duplicateTab.values = new Map(tab.values);
  const secondStorage = createDraftStorage(disk, duplicateTab, "page-2");
  const second = createDraftDocument(secondStorage, scope);
  type(second, " second tab");
  second.flush();
  type(draft, " first tab");
  draft.flush();
  assert.equal(
    createDraftDocument(createDraftStorage(disk, tab, "page-3"), scope).state.doc.toString(),
    "shared starting point first tab",
  );
  assert.equal(
    createDraftDocument(
      createDraftStorage(disk, duplicateTab, "page-4"),
      scope,
    ).state.doc.toString(),
    "shared starting point second tab",
  );
  assert.equal(
    createDraftDocument(secondStorage, draftScope("another user", "chat")).state.doc.length,
    0,
  );
  assert.equal(
    createDraftDocument(secondStorage, draftScope("owner", "another chat")).state.doc.length,
    0,
  );
});
test("assigning a session moves the complete draft and leaves an empty new-chat slot", () => {
  const { storage } = setup();
  const draft = createDraftDocument(storage, draftScope("owner"));
  type(draft, "message");
  draft.setFiles("attachment-snapshot");
  draft.move(draftScope("owner", "assigned"));
  assert.equal(createDraftDocument(storage, draftScope("owner")).state.doc.length, 0);
  const assigned = createDraftDocument(storage, draftScope("owner", "assigned"));
  assert.equal(assigned.state.doc.toString(), "message");
  assert.equal(assigned.filesKey, "attachment-snapshot");
  command(assigned, undo);
  assert.equal(assigned.state.doc.length, 0);
});
test("storage failures retain WIP in memory and report that persistence failed", () => {
  const { disk, tab, scope } = setup();
  disk.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const storage = createDraftStorage(disk, tab, "restricted");
  const draft = createDraftDocument(storage, scope);
  type(draft, "keep this");
  assert.equal(draft.flush(), false);
  assert.equal(createDraftDocument(storage, scope).state.doc.toString(), "keep this");
});
test("malformed saved history preserves valid draft text", () => {
  const { storage, scope } = setup();
  storage.save(scope, { version: 1, updatedAt: 1, editor: { doc: "recover me", history: null } });
  assert.equal(createDraftDocument(storage, scope).state.doc.toString(), "recover me");
  assert.equal(parseDraft("not json"), undefined);
  assert.equal(parseDraft('{"version":2}'), undefined);
});

test("a failed session move retains the previous on-disk recovery copy", () => {
  const { disk, tab, storage } = setup();
  const oldScope = draftScope("owner");
  const draft = createDraftDocument(storage, oldScope);
  type(draft, "recover after quota failure");
  draft.flush();
  disk.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(draft.move(draftScope("owner", "assigned")), false);
  const afterReload = createDraftStorage(disk, tab, "reloaded");
  assert.equal(
    createDraftDocument(afterReload, oldScope).state.doc.toString(),
    "recover after quota failure",
  );
});

test("late attachment persistence cannot overwrite newer text or resurrect removed files", () => {
  const { draft, storage, scope } = setup();
  type(draft, "first");
  draft.flush();
  const reopened = createDraftDocument(storage, scope);
  type(reopened, " plus edits");
  reopened.flush();
  draft.setFiles("late-files", true);
  draft.flush();
  assert.equal(createDraftDocument(storage, scope).state.doc.toString(), "first plus edits");
  type(reopened, " kept");
  reopened.flush();
  assert.equal(createDraftDocument(storage, scope).filesKey, "late-files");
  reopened.setFiles(undefined);
  reopened.flush();
  draft.setFiles("stale-files", true);
  draft.flush();
  assert.equal(createDraftDocument(storage, scope).filesKey, undefined);
});

test("reloads deduplicate identical snapshots without deleting another tab's work", () => {
  const disk = new MemoryStorage(),
    tab = new MemoryStorage();
  for (let page = 0; page < 20; page++) {
    const storage = createDraftStorage(disk, tab, String(page));
    storage.save("scope", { version: 1, updatedAt: page, editor: { doc: "same work" } });
  }
  assert.equal(disk.length, 1);
  for (let page = 20; page < 40; page++) {
    createDraftStorage(disk, new MemoryStorage(), String(page)).save("scope", {
      version: 1,
      updatedAt: page,
      editor: { doc: `distinct work ${page}` },
    });
  }
  assert.equal(disk.length, 8);
  const overflow = createDraftStorage(disk, new MemoryStorage(), "overflow");
  assert.equal(
    overflow.save("scope", { version: 1, updatedAt: 50, editor: { doc: "keep in memory" } }),
    false,
  );
  assert.equal(overflow.load("scope")?.editor.doc, "keep in memory");
  assert.equal(disk.length, 8);
});
test("replacing the final attachment reference reclaims its stored files", () => {
  const disk = new MemoryStorage(),
    tab = new MemoryStorage(),
    reclaimed: string[] = [];
  const storage = createDraftStorage(disk, tab, "writer", (keys) => reclaimed.push(...keys));
  storage.save("scope", { version: 1, updatedAt: 1, editor: { doc: "work" }, filesKey: "files" });
  storage.save("scope", { version: 1, updatedAt: 2, editor: { doc: "work" } });
  assert.deepEqual(reclaimed, ["files"]);
});
test("late acknowledgment cannot clear edits in a remounted document", () => {
  const { draft, storage, scope } = setup();
  type(draft, "send");
  draft.flush();
  const submission = draft.capture();
  const remounted = createDraftDocument(storage, scope);
  type(remounted, " new work");
  remounted.flush();
  assert.equal(draft.acknowledge(submission), undefined);
  assert.equal(storage.load(scope)?.editor.doc, "send new work");
});

test("writer locks reuse a reloaded tab branch and fork a duplicated live tab", async () => {
  const { claimDraftWriter } = await import("../lib/composer-draft.ts");
  const tab = new MemoryStorage();
  const held = new Set<string>();
  const locks = {
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: { name: string } | null) => Promise<void> | undefined,
    ) => {
      const available = !held.has(name);
      if (available) held.add(name);
      return callback(available ? { name } : null);
    },
  };
  const first = await claimDraftWriter(tab, locks);
  const duplicate = new MemoryStorage();
  duplicate.setItem("eve:web:composer-writer:v1", first);
  assert.notEqual(await claimDraftWriter(duplicate, locks), first);
  held.delete(`eve:composer:${first}`);
  assert.equal(await claimDraftWriter(tab, locks), first);
});
