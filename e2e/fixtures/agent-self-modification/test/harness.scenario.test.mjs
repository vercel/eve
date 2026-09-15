import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SelfModificationHarness,
  withSelfModification,
} from "../evals/self-modification/harness.ts";

async function sourceTree() {
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-test-"));
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "keep.txt"), "baseline");
  await writeFile(join(root, "nested", "delete.txt"), "delete me");
  await writeFile(join(root, "nested", "binary.bin"), Buffer.from([0, 1, 2, 255]));
  return root;
}

function response(body = {}) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function context(target, signal = new AbortController().signal) {
  return {
    signal,
    target,
    log() {},
    calledSubagent() {},
    start: async () => {
      throw new Error("start was not expected");
    },
    newSession: () => {
      throw new Error("newSession was not expected");
    },
  };
}

function completedTurn(sessionId, events = []) {
  return {
    sessionId,
    events,
    expectOk() {},
    calledSubagent() {},
    requireToolCall() {},
  };
}

function targetFor({ calls = [], turns = {} } = {}) {
  return {
    kind: "local",
    async fetch(path, options = {}) {
      calls.push({ path, options });
      return response({ revision: "revision-after-cleanup" });
    },
    watchTurn(sessionId) {
      return turns[sessionId];
    },
  };
}

async function withHarness(run, setup = {}, makeContext = context) {
  const root = await sourceTree();
  const calls = [];
  const target = targetFor({ ...setup, calls });
  const harness = await SelfModificationHarness.create(makeContext(target), root);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await harness.close();
    }
  };
  try {
    return await run({ harness, root, calls, target, close });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}

async function assertTreeRestored(root) {
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "baseline");
  assert.equal(await readFile(join(root, "nested", "delete.txt"), "utf8"), "delete me");
  assert.deepEqual(await readFile(join(root, "nested", "binary.bin")), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(readFile(join(root, "unexpected.txt")));
}

test("close restores the complete source tree, including deleted, changed, binary, and unexpected files", async () => {
  await withHarness(async ({ root, close }) => {
    await writeFile(join(root, "keep.txt"), "changed");
    await rm(join(root, "nested", "delete.txt"));
    await writeFile(join(root, "nested", "binary.bin"), Buffer.from([9, 8, 7]));
    await writeFile(join(root, "unexpected.txt"), "not in baseline");
    await close();
    await assertTreeRestored(root);
  });
});

test("request tracks the parent and child, and close retires both before restoring", async () => {
  const childLive = {
    sessionId: "child",
    events: [],
    async result() {
      return completedTurn("child");
    },
  };
  const parentEvent = {
    type: "subagent.called",
    data: { name: "self-modification", childSessionId: "child" },
  };
  const parentLive = {
    sessionId: "parent",
    events: [parentEvent],
    async waitForEvent() {
      return { data: parentEvent.data };
    },
    async result() {
      return completedTurn("parent", [parentEvent]);
    },
  };
  await withHarness(
    async ({ harness, root, calls, target, close }) => {
      let parentFinished = false;
      parentLive.result = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        parentFinished = true;
        return completedTurn("parent", [parentEvent]);
      };
      target.watchTurn = () => {
        assert.equal(parentFinished, false);
        return childLive;
      };
      await harness.request("make a change");
      await writeFile(join(root, "unexpected.txt"), "mutation");
      const retiring = Promise.withResolvers();
      const released = Promise.withResolvers();
      const fetch = target.fetch;
      target.fetch = async (path, options) => {
        if (path.endsWith("/child/reset")) {
          retiring.resolve();
          await released.promise;
        }
        return fetch(path, options);
      };
      const closing = close();
      await retiring.promise;
      assert.equal(await readFile(join(root, "unexpected.txt"), "utf8"), "mutation");
      assert.equal(
        calls.some((call) => call.path.includes("/suspend?")),
        false,
      );
      released.resolve();
      await closing;

      const resetPaths = calls
        .filter((call) => call.path.endsWith("/reset"))
        .map((call) => call.path);
      assert.deepEqual(resetPaths, ["/eve/v1/session/parent/reset", "/eve/v1/session/child/reset"]);
      assert.ok(
        calls.findIndex((call) => call.path.endsWith("/reset")) <
          calls.findIndex((call) => call.path.includes("/suspend?lease=")),
      );
      await assertTreeRestored(root);
    },
    {},
    (target) => {
      const t = context(target);
      t.start = async () => parentLive;
      return t;
    },
  );
});

test("verification sessions are retired before restore", async () => {
  const live = {
    sessionId: "verification",
    events: [],
    async result() {
      return completedTurn("verification");
    },
  };
  await withHarness(
    async ({ harness, calls, close }) => {
      await harness.verify("verify it");
      await close();
      assert.ok(calls.some((call) => call.path === "/eve/v1/session/verification/reset"));
      assert.ok(
        calls.findIndex((call) => call.path.includes("verification/reset")) <
          calls.findIndex((call) => call.path.includes("/suspend?")),
      );
    },
    {},
    (target) => {
      const t = context(target);
      t.newSession = () => ({ start: async () => live });
      return t;
    },
  );
});

test("one reset failure still retires other sessions and leaves unsafe source untouched", async () => {
  const root = await sourceTree();
  const calls = [];
  const target = targetFor({ calls });
  target.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes("bad/reset")) return new Response("no", { status: 500 });
    return response({ revision: "revision" });
  };
  const parentEvent = {
    type: "subagent.called",
    data: { name: "self-modification", childSessionId: "bad" },
  };
  // The public request path is used to populate both tracked sessions.
  const liveParent = {
    sessionId: "parent",
    events: [parentEvent],
    async waitForEvent() {
      return { data: parentEvent.data };
    },
    async result() {
      return completedTurn("parent", [parentEvent]);
    },
  };
  target.watchTurn = () => ({
    sessionId: "bad",
    events: [],
    async result() {
      return completedTurn("bad");
    },
  });
  const t = context(target);
  t.start = async () => liveParent;
  const populated = await SelfModificationHarness.create(t, root);
  await populated.request("mutate");
  await writeFile(join(root, "keep.txt"), "unsafe mutation");
  await assert.rejects(populated.close(), /could not be retired/);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "unsafe mutation");
  assert.equal(calls.filter((call) => call.path.endsWith("/reset")).length, 2);
  assert.equal(
    calls.some((call) => call.path.includes("/suspend?")),
    false,
  );
  target.fetch = targetFor({ calls }).fetch;
  await populated.close();
  await rm(root, { recursive: true, force: true });
});

test("close uses its own live cleanup signal after the eval signal is aborted", async () => {
  const controller = new AbortController();
  const calls = [];
  const root = await sourceTree();
  const target = targetFor({ calls });
  const harness = await SelfModificationHarness.create(context(target, controller.signal), root);
  controller.abort();
  await harness.close();
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every(({ options }) => options.signal !== controller.signal && !options.signal.aborted),
  );
  await rm(root, { recursive: true, force: true });
});

test("source paths reject absolute paths and traversal", async () => {
  await withHarness(async ({ harness }) => {
    for (const path of ["../outside", "nested/../../outside", "/absolute", "nested\\..\\outside"]) {
      assert.throws(() => harness.readSource(path), /must be relative/);
      await assert.rejects(harness.writeSource(path, "bad"), /must be relative/);
    }
  });
});

test("assertOnlyChanged allows listed modifications and rejects unexpected or deleted files", async () => {
  await withHarness(async ({ harness, root, close }) => {
    await writeFile(join(root, "keep.txt"), "allowed");
    await harness.assertOnlyChanged(["keep.txt"]);
    await writeFile(join(root, "unexpected.txt"), "bad");
    await assert.rejects(
      harness.assertOnlyChanged(["keep.txt"]),
      /unrelated source file: unexpected.txt/,
    );
    await rm(join(root, "nested", "delete.txt"));
    await assert.rejects(
      harness.assertOnlyChanged(["keep.txt"]),
      /unrelated source file: nested\/delete.txt/,
    );
    await close();
  });
});

test("separate eval bundles serialize cleanup before the next source snapshot", async () => {
  const otherBundle = await import("../evals/self-modification/harness.ts?other-eval");
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-serial-"));
  const cwd = process.cwd();
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  const restoring = Promise.withResolvers();
  const release = Promise.withResolvers();
  const target = targetFor();
  const fetch = target.fetch;
  target.fetch = async (path, options) => {
    if (path.includes("/suspend?")) {
      restoring.resolve();
      await release.promise;
    }
    return fetch(path, options);
  };
  process.chdir(root);
  try {
    const first = withSelfModification(context(target), async (harness) => {
      await harness.writeSource("instructions.md", "changed");
    });
    await restoring.promise;
    let secondStarted = false;
    const second = otherBundle.withSelfModification(context(targetFor()), async (harness) => {
      secondStarted = true;
      assert.equal(await harness.readSource("instructions.md"), "baseline");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(secondStarted, true);
  } finally {
    release.resolve();
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout lock rejects another eval process before source mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-locked-"));
  const cwd = process.cwd();
  await mkdir(join(root, "agent"));
  await mkdir(join(root, ".eve-self-modification-eval.lock"));
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  process.chdir(root);
  try {
    let started = false;
    await assert.rejects(
      withSelfModification(context(targetFor()), async () => {
        started = true;
      }),
      /Another self-modification eval owns this checkout/,
    );
    assert.equal(started, false);
    assert.equal(await readFile(join(root, "agent", "instructions.md"), "utf8"), "baseline");
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed eval restores source, releases its checkout lock, and preserves the failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-failed-"));
  const cwd = process.cwd();
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  const failure = new Error("authoring failed");
  process.chdir(root);
  try {
    await assert.rejects(
      withSelfModification(context(targetFor()), async (harness) => {
        await harness.writeSource("instructions.md", "changed");
        await harness.writeSource("tools/unexpected.ts", "unexpected");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(await readFile(join(root, "agent", "instructions.md"), "utf8"), "baseline");
    await assert.rejects(readFile(join(root, "agent", "tools", "unexpected.ts")));
    await assert.rejects(readFile(join(root, ".eve-self-modification-eval.lock", "owner.json")));
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("apply rejects a rebuild response without a runtime revision", async () => {
  await withHarness(async ({ harness, target, close }) => {
    let apply = true;
    target.fetch = async () => {
      if (apply) {
        apply = false;
        return response({});
      }
      return response({ revision: "cleanup-revision" });
    };
    await assert.rejects(harness.apply(), /did not return a runtime revision/);
    await close();
  });
});

test("request falls back to a parent-boundary watch when the initial event is missed", async () => {
  const root = await sourceTree();
  const calls = [];
  const continuation = {
    sessionId: "parent",
    events: [],
    async waitForEvent() {
      return { data: { name: "self-modification", childSessionId: "child" } };
    },
    async result() {
      return completedTurn("parent");
    },
  };
  const child = {
    sessionId: "child",
    events: [],
    async result() {
      return completedTurn("child");
    },
  };
  const target = targetFor({ calls, turns: { parent: continuation, child } });
  const parent = {
    sessionId: "parent",
    events: [],
    session: { state: { streamIndex: 10 } },
    async waitForEvent() {
      throw new Error("stream boundary");
    },
    async result() {
      return completedTurn("parent");
    },
  };
  const t = context(target);
  t.start = async () => parent;
  const harness = await SelfModificationHarness.create(t, root);
  await harness.request("make a change");
  await harness.close();
  await rm(root, { recursive: true, force: true });
});

test("cleanup failure retains a lock that identifies the source backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-cleanup-failed-"));
  const cwd = process.cwd();
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  const target = targetFor();
  target.fetch = async (path) =>
    path.includes("/suspend?")
      ? new Response("no", { status: 500 })
      : response({ revision: "revision" });
  process.chdir(root);
  let backupRoot;
  try {
    await assert.rejects(
      withSelfModification(context(target), async (harness) => {
        await harness.writeSource("instructions.md", "changed");
      }),
      /suspend.*failed: 500/,
    );
    const owner = JSON.parse(
      await readFile(join(root, ".eve-self-modification-eval.lock", "owner.json"), "utf8"),
    );
    backupRoot = owner.backupRoot;
    assert.equal(typeof backupRoot, "string");
    assert.equal(await readFile(join(backupRoot, "agent", "instructions.md"), "utf8"), "baseline");
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
  }
});
