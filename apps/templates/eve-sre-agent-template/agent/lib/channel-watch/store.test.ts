import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelWatchAuthError,
  ChannelWatchStore,
  type WatchObjectStore,
} from "./store.ts";

class MemoryObjectStore implements WatchObjectStore {
  readonly objects = new Map<string, string>();

  delete(objectPath: string): Promise<void> {
    this.objects.delete(objectPath);
    return Promise.resolve();
  }

  read(objectPath: string): Promise<string | null> {
    return Promise.resolve(this.objects.get(objectPath) ?? null);
  }

  write(objectPath: string, content: string): Promise<void> {
    this.objects.set(objectPath, content);
    return Promise.resolve();
  }
}

const alice = {
  attributes: { team_id: "T1" },
  authenticator: "slack-webhook",
  issuer: "slack:T1",
  principalId: "U1",
  principalType: "user",
} as const;
const key = { channelId: "C1", teamId: "T1" };
const pathname = "sre-channel-watch/T1/C1.json";

function testStore() {
  let tick = 0;
  const objects = new MemoryObjectStore();
  const store = new ChannelWatchStore(objects, () => {
    const second = tick;
    tick += 1;
    return new Date(Date.UTC(2026, 7, 18, 12, 0, second));
  });
  return { objects, store };
}

test("uses the raw Slack IDs in the watch path", async () => {
  const { objects, store } = testStore();
  await store.watch(alice, key);

  assert.deepEqual(JSON.parse(objects.objects.get(pathname) ?? ""), {
    watchedAt: "2026-08-18T12:00:00.000Z",
    watchedBy: "U1",
  });
});

test("has reflects blob presence", async () => {
  const { store } = testStore();
  assert.equal(await store.has(key), false);
  await store.watch(alice, key);
  assert.equal(await store.has(key), true);
  await store.unwatch(alice, key);
  assert.equal(await store.has(key), false);
});

test("watch overwrites one deterministic blob", async () => {
  const { objects, store } = testStore();
  await store.watch(alice, key);
  await store.watch(alice, key);

  assert.equal(objects.objects.size, 1);
  assert.deepEqual(JSON.parse(objects.objects.get(pathname) ?? ""), {
    watchedAt: "2026-08-18T12:00:01.000Z",
    watchedBy: "U1",
  });
});

test("unwatch succeeds when the blob is missing", async () => {
  const { objects, store } = testStore();
  await store.unwatch(alice, key);
  assert.equal(objects.objects.size, 0);
});

test("mutations reject bot and service principals", async () => {
  const { store } = testStore();
  const bot = {
    authenticator: "slack-webhook",
    principalId: "B1",
    principalType: "bot",
  };
  const service = {
    authenticator: "service",
    principalId: "eve:app",
    principalType: "user",
  };

  await assert.rejects(store.watch(bot, key), ChannelWatchAuthError);
  await assert.rejects(store.unwatch(service, key), ChannelWatchAuthError);
});

test("has fails closed when the read fails", async () => {
  const objects: WatchObjectStore = {
    delete(): Promise<void> {
      return Promise.resolve();
    },
    read(): Promise<string | null> {
      return Promise.reject(new Error("unavailable"));
    },
    write(): Promise<void> {
      return Promise.resolve();
    },
  };
  const store = new ChannelWatchStore(objects);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await store.has(key), false);
  } finally {
    console.warn = originalWarn;
  }
});

test("garbage JSON still counts as watched", async () => {
  const { objects, store } = testStore();
  objects.objects.set(pathname, "{not-json");
  assert.equal(await store.has(key), true);
});
