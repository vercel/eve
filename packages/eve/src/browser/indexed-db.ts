// The slice of IndexedDB eve's browser stores use (sessions, sandbox workspaces), declared here
// because eve's TypeScript config has no DOM library. An object store is typed by what eve puts in
// it: each database is eve's own, and only these stores write it.

export interface IdbRequest<T> {
  readonly result: T;
  readonly error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

export interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
}

export type IdbKey = string | number | readonly (string | number)[];

export interface IdbObjectStore<V> {
  put(value: V, key?: IdbKey): IdbRequest<IdbKey>;
  get(key: IdbKey): IdbRequest<V | undefined>;
  getAll(query?: IdbKeyRange): IdbRequest<V[]>;
  count(query?: IdbKeyRange): IdbRequest<number>;
  delete(key: IdbKey): IdbRequest<undefined>;
}

export interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { readonly keyPath: string }): unknown;
  deleteObjectStore(name: string): void;
  transaction(name: string, mode: "readonly" | "readwrite"): IdbTransaction;
}

export interface IdbTransaction {
  objectStore<V>(name: string): IdbObjectStore<V>;
}

/** An opaque key range, as `IDBKeyRange.bound` makes it. */
export interface IdbKeyRange {
  readonly lower: unknown;
  readonly upper: unknown;
}

export interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest;
}

export interface IdbKeyRangeFactory {
  bound(lower: IdbKey, upper: IdbKey): IdbKeyRange;
}

declare global {
  // A page's and a worker's; Node has neither.
  var indexedDB: IdbFactory | undefined;
  var IDBKeyRange: IdbKeyRangeFactory | undefined;
}

/** This realm's IndexedDB; throws in one without (Node). */
export function idb(): { readonly factory: IdbFactory; readonly keyRange: IdbKeyRangeFactory } {
  const factory = globalThis.indexedDB;
  const keyRange = globalThis.IDBKeyRange;
  if (factory === undefined || keyRange === undefined) {
    throw new Error("This runtime has no IndexedDB.");
  }
  return { factory, keyRange };
}

/** Whether this realm has IndexedDB (a page or worker does; Node doesn't). */
export function hasIndexedDb(): boolean {
  return globalThis.indexedDB !== undefined;
}

/** `pending`'s result once it succeeds. */
export function request<T>(pending: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error ?? new Error("An IndexedDB request failed."));
  });
}

/** Opens database `name` at `version`, running `upgrade` when it's new or older. */
export function openDatabase(
  name: string,
  version: number,
  upgrade: (db: IdbDatabase) => void,
): Promise<IdbDatabase> {
  const open = idb().factory.open(name, version);
  open.onupgradeneeded = () => upgrade(open.result);
  return request(open);
}
