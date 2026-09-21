import { EditorState, type Extension } from "@codemirror/state";
import { history, historyField, isolateHistory } from "@codemirror/commands";

export const draftHistory = { history: historyField };
export const draftExtensions = () => [history({ minDepth: 100 })];
export interface DraftRecord {
  version: 1;
  updatedAt: number;
  editor: ReturnType<EditorState["toJSON"]>;
  filesKey?: string;
  revision?: number;
}
export interface DraftStorage {
  subscribe?(listener: (scope: string) => void): () => void;
  load(scope: string): DraftRecord | undefined;
  save(scope: string, record: DraftRecord): boolean;
}
const prefix = "eve:web:composer:v1:";
const MAX_DRAFT_BRANCHES = 8;
export function draftScope(owner: string, session?: string) {
  return `${encodeURIComponent(owner)}:${encodeURIComponent(session ?? "new")}`;
}

/** Each document writes its own branch; sessionStorage remembers this tab's branch on reload. */
export function createDraftStorage(
  disk: Storage,
  tab: Storage,
  writer: string,
  reclaim: (keys: string[]) => void = () => {},
): DraftStorage {
  const memory = new Map<string, DraftRecord>();
  const initialized = new Set<string>();
  const listeners = new Set<(scope: string) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(scope) {
      if (memory.has(scope)) return memory.get(scope);
      try {
        const base = `${prefix}${scope}:`;
        const own = disk.getItem(base + writer);
        const previousKey = tab.getItem(base);
        const previous = previousKey && disk.getItem(previousKey);
        const preferred = parseDraft(own ?? previous ?? null);
        if (preferred) return preferred;
        let latest: DraftRecord | undefined;
        for (let i = 0; i < disk.length; i++) {
          const key = disk.key(i);
          if (!key?.startsWith(base)) continue;
          const record = parseDraft(disk.getItem(key));
          if (record && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
        }
        return latest;
      } catch {
        return undefined;
      }
    },
    save(scope, record) {
      let previous = memory.get(scope);
      memory.set(scope, record);
      try {
        const base = `${prefix}${scope}:`;
        const key = base + writer;
        previous ??= parseDraft(disk.getItem(key));
        if (!disk.getItem(key)) {
          const snapshots = new Set<string>();
          for (let i = 0; i < disk.length; i++) {
            const candidate = disk.key(i);
            if (!candidate?.startsWith(base)) continue;
            const saved = parseDraft(disk.getItem(candidate));
            if (saved) snapshots.add(JSON.stringify([saved.editor, saved.filesKey]));
          }
          // Preserve distinct work from other tabs. At capacity the UI warns
          // that this tab's draft is memory-only instead of evicting their work.
          if (
            snapshots.size >= MAX_DRAFT_BRANCHES &&
            !snapshots.has(JSON.stringify([record.editor, record.filesKey]))
          )
            return false;
        }
        disk.setItem(key, JSON.stringify(record));
        tab.setItem(base, key);
        const removed: string[] = [];
        if (!initialized.has(scope)) {
          const branches: { key: string; record: DraftRecord }[] = [];
          for (let i = 0; i < disk.length; i++) {
            const candidate = disk.key(i);
            if (!candidate?.startsWith(base) || candidate === key) continue;
            const saved = parseDraft(disk.getItem(candidate));
            if (saved) branches.push({ key: candidate, record: saved });
          }
          // Distinct drafts may belong to another open tab. Only redundant
          // recovery snapshots can be discarded without losing that tab's work.
          const snapshots = new Set([JSON.stringify([record.editor, record.filesKey])]);
          branches.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
          for (const branch of branches) {
            const snapshot = JSON.stringify([branch.record.editor, branch.record.filesKey]);
            if (!snapshots.has(snapshot)) {
              snapshots.add(snapshot);
              continue;
            }
            disk.removeItem(branch.key);
            if (branch.record.filesKey) removed.push(branch.record.filesKey);
          }
          initialized.add(scope);
        }
        if (previous?.filesKey && previous.filesKey !== record.filesKey)
          removed.push(previous.filesKey);
        if (removed.length) {
          const referenced = new Set<string>();
          for (let i = 0; i < disk.length; i++) {
            const candidate = disk.key(i);
            if (!candidate?.startsWith(prefix)) continue;
            const file = parseDraft(disk.getItem(candidate))?.filesKey;
            if (file) referenced.add(file);
          }
          reclaim(removed.filter((file) => !referenced.has(file)));
        }
        listeners.forEach((listener) => listener(scope));
        return true;
      } catch {
        return false;
      }
    },
  };
}
export function parseDraft(raw: string | null): DraftRecord | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      !Number.isFinite(value.updatedAt) ||
      typeof value.editor?.doc !== "string"
    )
      return;
    if (value.filesKey !== undefined && typeof value.filesKey !== "string") return;
    return value;
  } catch {
    return;
  }
}
export function restoreDraft(record?: DraftRecord, extensions: Extension = []): EditorState {
  const config = { extensions: [draftExtensions(), extensions] };
  if (record) {
    try {
      return EditorState.fromJSON(record.editor, config, draftHistory);
    } catch {
      return EditorState.create({ ...config, doc: record.editor.doc });
    }
  }
  return EditorState.create(config);
}
export interface DraftSubmission {
  readonly state: EditorState;
  readonly revision: number;
}
export function createDraftDocument(
  storage: DraftStorage,
  initialScope: string,
  extensions: Extension = [],
) {
  let scope = initialScope;
  const record = storage.load(scope);
  let state = restoreDraft(record, extensions);
  let revision = record?.revision ?? 0;
  let filesKey = record?.filesKey;
  let filesDirty = false;
  let dirty = false;
  return {
    reload() {
      if (dirty) return false;
      const latest = storage.load(scope);
      if (!latest) return false;
      state = restoreDraft(latest, extensions);
      revision = latest.revision ?? 0;
      filesKey = latest.filesKey;
      return true;
    },
    get scope() {
      return scope;
    },
    refreshFiles() {
      filesKey = storage.load(scope)?.filesKey;
      return filesKey;
    },
    get state() {
      return state;
    },
    get filesKey() {
      return filesKey;
    },
    update(next: EditorState) {
      if (next.doc !== state.doc) revision++;
      state = next;
      dirty = true;
    },
    capture(): DraftSubmission {
      return { state, revision };
    },
    acknowledge(submission: DraftSubmission) {
      const latest = storage.load(scope);
      if (latest && (latest.revision ?? 0) > submission.revision) return;
      // A response must never erase edits made after the user pressed Send.
      if (
        revision !== submission.revision ||
        state.doc.toString() !== submission.state.doc.toString()
      )
        return;
      const transaction = state.update({
        changes: { from: 0, to: state.doc.length, insert: "" },
        selection: { anchor: 0 },
        annotations: isolateHistory.of("full"),
      });
      state = transaction.state;
      revision++;
      dirty = true;
      return transaction;
    },
    setFiles(key?: string, preserveLatestEditor = false) {
      if (preserveLatestEditor) {
        const latest = storage.load(scope);
        if (latest?.filesKey !== filesKey) return false;
        state = restoreDraft(latest, extensions);
        revision = latest?.revision ?? revision;
      }
      filesKey = key;
      filesDirty = true;
      dirty = true;
      return true;
    },
    move(nextScope: string) {
      if (nextScope === scope) return true;
      const previousScope = scope;
      scope = nextScope;
      filesDirty = true;
      dirty = true;
      // Persist the destination before clearing the old slot, so a quota failure
      // still leaves the original draft recoverable on disk.
      if (!this.flush()) return false;
      return storage.save(previousScope, {
        version: 1,
        updatedAt: Date.now(),
        editor: EditorState.create({ extensions: draftExtensions() }).toJSON(draftHistory),
      });
    },
    flush() {
      if (!dirty) return true;
      if (!filesDirty) filesKey = storage.load(scope)?.filesKey;
      const saved = storage.save(scope, {
        version: 1,
        updatedAt: Date.now(),
        editor: state.toJSON(draftHistory),
        revision,
        filesKey,
      });
      if (saved) {
        dirty = false;
        filesDirty = false;
      }
      return saved;
    },
  };
}
export type DraftDocument = ReturnType<typeof createDraftDocument>;

/** Reuse this tab's branch on reload; a duplicated live tab claims a new branch. */
export interface DraftWriterLocks {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: { name: string } | null) => Promise<void> | undefined,
  ): Promise<unknown>;
}
export async function claimDraftWriter(
  tab: Pick<Storage, "getItem" | "setItem">,
  locks?: DraftWriterLocks,
) {
  const key = "eve:web:composer-writer:v1";
  let previous: string | null = null;
  try {
    previous = tab.getItem(key);
  } catch {
    /* Restricted storage. */
  }
  const claim = (id: string) =>
    new Promise<boolean>((resolve, reject) => {
      void locks!
        .request(`eve:composer:${id}`, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          // The browser releases the lock when this document goes away.
          return lock ? new Promise<void>(() => {}) : undefined;
        })
        .catch(reject);
    });
  let writer = crypto.randomUUID();
  if (locks) {
    try {
      if (previous && (await claim(previous))) writer = previous;
      else await claim(writer);
    } catch {
      /* Fresh branches still isolate tabs when locks are unavailable. */
    }
  }
  try {
    tab.setItem(key, writer);
  } catch {
    /* Memory remains usable. */
  }
  return writer;
}
