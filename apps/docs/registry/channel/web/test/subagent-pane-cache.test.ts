import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentPaneCache } from "../lib/subagent-pane-cache.ts";
import { chatMessageReducer } from "../lib/chat-message-reducer.ts";
import type { SubagentSession } from "../lib/subagent-session.ts";

const child = (id: string): SubagentSession => ({
  sessionId: "parent",
  childSessionId: id,
  callId: id,
  childStreamPath: `/eve/v1/session/${id}/stream`,
  name: id,
  toolName: id,
  turnId: "turn",
  sequence: 1,
  workflowId: "workflow",
});

test("switching children retains independent replay cursors, history, and reading positions", () => {
  const cache = createSubagentPaneCache();
  const a = cache.get(child("a"));
  a.cursor = 42;
  a.status = "Idle";
  a.scrollTop = 350;
  a.followBottom = false;
  a.seen.add("event");
  a.data = chatMessageReducer().reduce(a.data, {
    type: "message.completed",
    data: {
      message: "kept answer",
      turnId: "turn",
      sequence: 1,
      stepIndex: 0,
      finishReason: "stop",
    },
    meta: { id: "answer", at: "2026-09-20T12:00:00Z" },
  });
  const b = cache.get(child("b"));
  assert.equal(b.cursor, 0);
  assert.equal(b.followBottom, true);
  assert.equal(cache.get(child("a")), a);
  assert.equal(cache.get(child("a")).cursor, 42);
  assert.equal(cache.get(child("a")).scrollTop, 350);
  assert.equal(cache.get(child("a")).followBottom, false);
  assert.equal(cache.get(child("a")).seen.has("event"), true);
  assert.match(JSON.stringify(cache.get(child("a")).data.messages), /kept answer/);
});

test("identity reset removes cached child data and scroll state", () => {
  const cache = createSubagentPaneCache();
  const a = cache.get(child("a"));
  a.cursor = 42;
  cache.clear();
  assert.notEqual(cache.get(child("a")), a);
  assert.equal(cache.get(child("a")).cursor, 0);
});

test("retained histories are bounded without evicting recently opened children", () => {
  const cache = createSubagentPaneCache();
  const first = cache.get(child("0"));
  const second = cache.get(child("1"));
  first.cursor = second.cursor = 1;
  for (let i = 2; i < 20; i++) cache.get(child(String(i))).cursor = 1;
  assert.equal(cache.get(child("0")), first);
  cache.get(child("20"));
  cache.flush();
  assert.equal(cache.get(child("0")), first);
  assert.notEqual(cache.get(child("1")), second);
});

test("unsubscribing parks the stream; reopening resumes the retained cursor", async () => {
  const paths: string[] = [],
    signals: AbortSignal[] = [];
  const cache = createSubagentPaneCache(async (path, init) => {
    paths.push(path);
    signals.push(init.signal as AbortSignal);
    return streamResponse(new ReadableStream());
  });
  try {
    const a = cache.get(child("a"));
    const close = a.subscribe(() => {});
    await tick();
    a.cursor = 12;
    close();
    await tick();
    assert.equal(signals[0].aborted, true);
    a.subscribe(() => {});
    await tick();
    assert.equal(new URL(paths[1], "http://local").searchParams.get("startIndex"), "12");
  } finally {
    cache.clear();
  }
});

test("different calls to the same child reuse its history and connection", () => {
  const cache = createSubagentPaneCache();
  const original = cache.get(child("a"));
  assert.equal(cache.get({ ...child("a"), callId: "followup-call" }), original);
  assert.notEqual(cache.get({ ...child("a"), remote: { url: "https://other.example" } }), original);
});

test("stream renewal resumes at the retained cursor without replaying history", async () => {
  const requests: string[] = [];
  const cache = createSubagentPaneCache(async (path) => {
    requests.push(path);
    if (requests.length === 1)
      return streamResponse(
        JSON.stringify({
          type: "message.completed",
          data: {
            message: "answer",
            turnId: "turn",
            sequence: 1,
            stepIndex: 0,
            finishReason: "stop",
          },
          meta: { id: "1", at: "2026-09-20T12:00:00Z" },
        }) + "\n",
      );
    return streamResponse(new ReadableStream());
  });
  try {
    const a = cache.get(child("a"));
    a.connect();
    await new Promise((resolve) => setTimeout(resolve, 25));
    a.subscribe(() => {});
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[1], "https://app.example").searchParams.get("startIndex"), "1");
    assert.match(JSON.stringify(a.data.messages), /answer/);
  } finally {
    cache.clear();
  }
});

test("workspace teardown aborts streams but Strict Mode effect reconnection keeps them", async () => {
  let signal: AbortSignal | undefined;
  const cache = createSubagentPaneCache(async (_path, init) => {
    signal = init.signal as AbortSignal;
    return streamResponse(new ReadableStream());
  });
  const release = cache.retain();
  const a = cache.get(child("a"));
  const unsubscribe = a.subscribe(() => {});
  release();
  const remountedRelease = cache.retain();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(signal?.aborted, false);
  assert.equal(cache.get(child("a")), a);
  unsubscribe();
  remountedRelease();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(signal?.aborted, true);
  assert.notEqual(cache.get(child("a")), a);
  cache.clear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
function disk() {
  const records = new Map<string, import("../lib/subagent-storage.ts").SubagentCheckpoint>();
  return {
    records,
    async load(owner: string, key: string) {
      return structuredClone(records.get(owner + key));
    },
    async save(
      owner: string,
      key: string,
      value: import("../lib/subagent-storage.ts").SubagentCheckpoint,
    ) {
      records.set(owner + key, structuredClone(value));
    },
    async clear(owner: string) {
      for (const key of records.keys()) if (key.startsWith(owner)) records.delete(key);
    },
  };
}
const eventLine = (id: string, text: string) =>
  JSON.stringify({
    type: "message.appended",
    data: { messageDelta: text, turnId: "turn", sequence: 1, stepIndex: 0 },
    meta: { id, at: "2026-09-21T12:00:00Z" },
  }) + "\n";

test("a fresh client restores the projection before subscribing at its saved cursor", async () => {
  const storage = disk();
  const first = createSubagentPaneCache(
    async () => streamResponse(eventLine("a", "Hello")),
    storage,
  );
  first.setOwner("alice");
  first.get(child("a")).connect();
  await tick();
  first.clear(); // Simulate document teardown, preserving disk.
  const requests: string[] = [];
  const second = createSubagentPaneCache(async (path) => {
    requests.push(path);
    return streamResponse(eventLine("b", " world"));
  }, storage);
  second.setOwner("alice");
  const entry = second.get(child("a"));
  try {
    entry.connect();
    await tick();
    assert.equal(new URL(requests[0], "http://local").searchParams.get("startIndex"), "1");
    assert.equal(entry.cursor, 2);
    assert.equal(entry.data.messages.length, 1);
    assert.match(JSON.stringify(entry.data.messages), /Hello world/);
    assert.equal(entry.getSnapshot().ready, true);
  } finally {
    second.clear();
  }
});

test("production cache does not read disk or connect before the viewer is known", async () => {
  let requests = 0;
  const storage = disk();
  let loads = 0;
  const cache = createSubagentPaneCache(
    async () => {
      requests++;
      return streamResponse(new ReadableStream());
    },
    {
      ...storage,
      async load(owner, key) {
        loads++;
        return storage.load(owner, key);
      },
    },
  );
  cache.get(child("a")).connect();
  await tick();
  assert.equal(loads, 0);
  assert.equal(requests, 0);
  cache.setOwner("alice");
  await tick();
  assert.equal(loads, 1);
  assert.equal(requests, 1);
  cache.clear();
});

test("storage failure falls back to the durable stream without losing functionality", async () => {
  let path = "";
  const storage = disk();
  const cache = createSubagentPaneCache(
    async (p) => {
      path = p;
      return streamResponse(eventLine("a", "answer"));
    },
    {
      ...storage,
      async load() {
        throw new Error("blocked");
      },
      async save() {
        throw new Error("quota");
      },
    },
  );
  cache.setOwner("alice");
  const entry = cache.get(child("a"));
  entry.connect();
  await tick();
  assert.equal(new URL(path, "http://local").searchParams.get("startIndex"), "0");
  assert.match(JSON.stringify(entry.data), /answer/);
  cache.clear();
});

test("switching identities cancels restoration and cannot publish the previous owner's messages", async () => {
  const storage = disk();
  let resolveLoad: (value: undefined) => void = () => {};
  let requests = 0;
  const cache = createSubagentPaneCache(
    async () => {
      requests++;
      return streamResponse(new ReadableStream());
    },
    {
      ...storage,
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    },
  );
  cache.setOwner("alice");
  const old = cache.get(child("a"));
  old.connect();
  await tick();
  cache.setOwner("bob");
  resolveLoad(undefined);
  await tick();
  assert.equal(requests, 0);
  assert.equal(old.getSnapshot().ready, false);
  assert.notEqual(cache.get(child("a")), old);
  cache.clear();
});

test("terminal snapshots restore immediately without reopening a finished stream", async () => {
  const storage = disk();
  const first = createSubagentPaneCache(
    async () =>
      streamResponse(
        eventLine("a", "finished") +
          JSON.stringify({
            type: "session.completed",
            data: {},
            meta: { id: "end", at: "2026-09-21T12:01:00Z" },
          }) +
          "\n",
      ),
    storage,
  );
  first.setOwner("alice");
  first.get(child("a")).connect();
  await tick();
  first.clear();
  let requests = 0;
  const second = createSubagentPaneCache(async () => {
    requests++;
    return streamResponse();
  }, storage);
  second.setOwner("alice");
  const entry = second.get(child("a"));
  entry.connect();
  await tick();
  assert.equal(requests, 0);
  assert.equal(entry.getSnapshot().ready, true);
  assert.equal(entry.terminal, true);
  assert.match(JSON.stringify(entry.data), /finished/);
  second.clear();
});

test("invalid checkpoint versions cannot advance the cursor without a matching transcript", async () => {
  const storage = disk();
  let path = "";
  const cache = createSubagentPaneCache(
    async (p) => {
      path = p;
      return streamResponse(new ReadableStream());
    },
    {
      ...storage,
      async load() {
        return JSON.parse('{"version":0,"cursor":200}');
      },
    },
  );
  cache.setOwner("alice");
  cache.get(child("a")).connect();
  await tick();
  assert.equal(new URL(path, "http://local").searchParams.get("startIndex"), "0");
  cache.clear();
});

test("cold status rows never publish historical activity while catching up", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const storage = disk();
  const cache = createSubagentPaneCache(
    async () =>
      streamResponse(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "x-eve-stream-tail-index": "2" } },
      ),
    storage,
  );
  cache.setOwner("alice");
  const entry = cache.get(child("a"));
  const phases: string[] = [];
  entry.subscribe(() => {
    if (entry.getSnapshot().ready) phases.push(entry.getSnapshot().progress.phase);
  });
  try {
    await tick();
    stream.enqueue(new TextEncoder().encode(eventLine("a", "old progress")));
    await tick();
    assert.equal(entry.getSnapshot().ready, false);
    assert.deepEqual(phases, []);
    stream.enqueue(new TextEncoder().encode(eventLine("b", "older progress")));
    await tick();
    assert.deepEqual(phases, []);
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "turn.completed",
          data: { turnId: "turn" },
          meta: { id: "end", at: "2026-09-21T12:01:00Z" },
        }) + "\n",
      ),
    );
    await tick();
    assert.deepEqual(phases, ["done"]);
    assert.equal(entry.cursor, 3);
    cache.flush();
    await tick();
    assert.equal([...storage.records.values()][0].cursor, 3);
  } finally {
    cache.clear();
  }
});

test("a restored done row stays done while an unsaved historical tail catches up", async () => {
  const storage = disk();
  const first = createSubagentPaneCache(
    async () => streamResponse(eventLine("a", "saved")),
    storage,
  );
  first.setOwner("alice");
  const original = first.get(child("a"));
  original.connect();
  await tick();
  original.progress = { phase: "done", startedAt: 0, endedAt: 42000, update: "finished" };
  first.clear();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let resumedAt = "";
  const second = createSubagentPaneCache(async (path) => {
    resumedAt = new URL(path, "http://local").searchParams.get("startIndex")!;
    return streamResponse(
      new ReadableStream({
        start(c) {
          stream = c;
        },
      }),
      {
        headers: { "x-eve-stream-tail-index": "2" },
      },
    );
  }, storage);
  second.setOwner("alice");
  const entry = second.get(child("a"));
  entry.connect();
  try {
    await tick();
    assert.equal(resumedAt, "1");
    assert.equal(
      entry.getSnapshot().status,
      "Completed",
      "restore status from saved task progress",
    );
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "turn.started",
          data: { turnId: "next", sequence: 2 },
          meta: { id: "start", at: "2026-09-21T12:01:00Z" },
        }) + "\n",
      ),
    );
    await tick();
    assert.equal(entry.getSnapshot().progress.phase, "done");
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "turn.completed",
          data: { turnId: "next" },
          meta: { id: "end", at: "2026-09-21T12:02:00Z" },
        }) + "\n",
      ),
    );
    await tick();
    assert.equal(entry.getSnapshot().progress.phase, "done");
    assert.equal(entry.cursor, 3);
  } finally {
    second.clear();
  }
});

test("terminal events before the advertised tail publish and persist completion", async () => {
  for (const type of ["session.completed", "session.failed"]) {
    const storage = disk();
    const cache = createSubagentPaneCache(
      async () =>
        streamResponse(
          eventLine("answer", "final answer") +
            JSON.stringify({
              type,
              data: { message: "failure detail" },
              meta: { id: "terminal", at: "2026-09-21T12:01:00Z" },
            }) +
            "\n",
          { headers: { "x-eve-stream-tail-index": "3" } },
        ),
      storage,
    );
    cache.setOwner("alice");
    const entry = cache.get(child("a"));
    entry.connect();
    try {
      await tick();
      assert.equal(entry.getSnapshot().ready, true);
      assert.equal(
        entry.getSnapshot().status,
        type === "session.completed" ? "Completed" : "Failed",
      );
      assert.match(JSON.stringify(entry.getSnapshot().data.messages), /final answer/);
      cache.flush();
      await tick();
      const checkpoint = [...storage.records.values()][0];
      assert.equal(checkpoint.terminal, true);
      assert.equal(checkpoint.cursor, 2);
    } finally {
      cache.clear();
    }
  }
});

test("a completed turn stays completed through waiting and late child notifications", async () => {
  const events = ["turn.started", "turn.completed", "session.waiting", "subagent.completed"]
    .map(
      (type, index) =>
        JSON.stringify({
          type,
          data: { turnId: "turn" },
          meta: { id: String(index), at: "2026-09-21T12:01:00Z" },
        }) + "\n",
    )
    .join("");
  const cache = createSubagentPaneCache(async () => streamResponse(events));
  try {
    const entry = cache.get(child("a"));
    entry.connect();
    await tick();
    assert.equal(entry.getSnapshot().status, "Completed");
    assert.equal(entry.getSnapshot().progress.phase, "done");
    assert.equal(entry.terminal, false, "a completed turn can still receive a follow-up");
  } finally {
    cache.clear();
  }
});

function streamResponse(body?: BodyInit | null, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-eve-stream-version", "25");
  return new Response(body, { ...init, headers });
}

test("many historical child rows use at most four concurrent stream readers", async () => {
  let active = 0,
    maximum = 0;
  const cache = createSubagentPaneCache(async (_path, init) => {
    active++;
    maximum = Math.max(maximum, active);
    init.signal!.addEventListener("abort", () => active--, { once: true });
    return streamResponse(new ReadableStream());
  });
  const close = Array.from({ length: 25 }, (_, i) =>
    cache.get(child(String(i))).subscribe(() => {}),
  );
  await tick();
  assert.equal(maximum, 4);
  close.forEach((stop) => stop());
  await tick();
  assert.equal(active, 0);
  cache.clear();
});
