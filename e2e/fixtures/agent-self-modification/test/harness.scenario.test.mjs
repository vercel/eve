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

async function temporaryCheckout(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = process.cwd();
  await mkdir(join(root, "agent"));
  process.chdir(root);
  t.after(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });
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
    session: () => {
      throw new Error("session was not expected");
    },
  };
}

function completedTurn(sessionId, events = []) {
  return {
    sessionId,
    events,
    expectOk() {},
    calledSubagent() {},
    requireToolCall() {
      return { input: {} };
    },
  };
}

function liveTurn(sessionId, events = []) {
  return {
    sessionId,
    events,
    async result() {
      return completedTurn(sessionId, events);
    },
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

test("close restores registry installer project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-selfmod-project-"));
  await mkdir(join(root, "agent"));
  await writeFile(join(root, ".env.example"), "EXISTING=original\n");
  await writeFile(join(root, "package.json"), '{"name":"original"}\n');
  const harness = await SelfModificationHarness.create(context(targetFor()), join(root, "agent"));
  try {
    await writeFile(join(root, ".env.example"), "EXISTING=changed\n");
    await writeFile(join(root, ".env.local"), "BROWSER_USE_API_KEY=\n");
    await writeFile(join(root, "package.json"), '{"name":"changed"}\n');
    await harness.close();
    assert.equal(await readFile(join(root, ".env.example"), "utf8"), "EXISTING=original\n");
    assert.equal(await readFile(join(root, "package.json"), "utf8"), '{"name":"original"}\n');
    await assert.rejects(readFile(join(root, ".env.local")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("close retires every session before restoring the complete source tree", async () => {
  const child = liveTurn("child");
  const verification = liveTurn("verification");
  const parentEvent = {
    type: "task.started",
    data: { name: "self-modification__agent", child: { sessionId: child.sessionId } },
  };
  const parent = liveTurn("parent", [parentEvent]);

  await withHarness(
    async ({ harness, root, calls, target, close }) => {
      let parentFinished = false;
      parent.result = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        parentFinished = true;
        return completedTurn(parent.sessionId, [parentEvent]);
      };
      parent.waitForEvent = async () => ({ data: parentEvent.data });
      target.watchTurn = () => {
        assert.equal(parentFinished, true);
        return child;
      };

      await harness.request("make a change");
      await harness.verify("verify it");
      await writeFile(join(root, "keep.txt"), "changed");
      await rm(join(root, "nested", "delete.txt"));
      await writeFile(join(root, "nested", "binary.bin"), Buffer.from([9, 8, 7]));
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

      assert.deepEqual(
        calls
          .filter((call) => call.path.endsWith("/reset"))
          .map((call) => call.path)
          .sort(),
        [parent, child, verification]
          .map((turn) => `/eve/v1/session/${turn.sessionId}/reset`)
          .sort(),
      );
      assert.ok(
        calls.findLastIndex((call) => call.path.endsWith("/reset")) <
          calls.findIndex((call) => call.path.includes("/suspend?lease=")),
      );
      await assertTreeRestored(root);
    },
    {},
    (target) => {
      const t = context(target);
      let creations = 0;
      t.session = async () => ({ start: async () => (++creations === 1 ? parent : verification) });
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
    type: "task.started",
    data: { name: "self-modification__agent", child: { sessionId: "bad" } },
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
  t.session = async () => ({ start: async () => liveParent });
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

test("separate eval bundles serialize cleanup before the next source snapshot", async (t) => {
  const otherBundle = await import("../evals/self-modification/harness.ts?other-eval");
  const root = await temporaryCheckout(t, "eve-selfmod-serial-");
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
});

test("checkout lock rejects another eval process before source mutation", async (t) => {
  const root = await temporaryCheckout(t, "eve-selfmod-locked-");
  await mkdir(join(root, ".eve-self-modification-eval.lock"));
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  let started = false;
  await assert.rejects(
    withSelfModification(context(targetFor()), async () => {
      started = true;
    }),
    /Another self-modification eval owns this checkout/,
  );
  assert.equal(started, false);
  assert.equal(await readFile(join(root, "agent", "instructions.md"), "utf8"), "baseline");
});

test("a failed eval restores source, releases its checkout lock, and preserves the failure", async (t) => {
  const root = await temporaryCheckout(t, "eve-selfmod-failed-");
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  const failure = new Error("authoring failed");
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

for (const emitsCalled of [false, true]) {
  test(`request follows a reused agent past stale turns (new called event: ${emitsCalled})`, async () => {
    const called = {
      type: "task.started",
      data: { name: "self-modification__agent", taskId: "agent-1", child: { sessionId: "child" } },
    };
    const initialParent = liveTurn("parent", [called]);
    initialParent.waitForEvent = async () => called;
    const initialChild = liveTurn("child");
    initialChild.session = { state: { streamIndex: 10 } };
    const message = "Repair the existing inventory tool.";
    const repairParent = liveTurn("parent", emitsCalled ? [called] : []);
    repairParent.waitForEvent = async () => {
      throw new Error("Session reached session.waiting before the expected event.");
    };
    repairParent.result = async () => ({
      ...completedTurn("parent"),
      requireToolCall: () => ({ input: { taskId: "agent-1", message } }),
    });
    const diagnostic = liveTurn("child", [
      { type: "message.received", data: { message: "Diagnose only." } },
    ]);
    diagnostic.session = { state: { streamIndex: 20 } };
    diagnostic.result = async () => ({
      ...completedTurn("child", diagnostic.events),
      status: "waiting",
    });
    const repaired = liveTurn("child", [
      ...diagnostic.events,
      { type: "message.received", data: { message } },
    ]);
    repaired.session = { state: { streamIndex: 30 } };
    const observed = [];
    await withHarness(async ({ harness, target }) => {
      const children = [initialChild, diagnostic, repaired];
      target.watchTurn = (sessionId, options) => {
        observed.push({ sessionId, ...options });
        return children.shift();
      };
      await harness.request("Create the tool.", { start: async () => initialParent });
      const result = await harness.request("Please repair it.", {
        start: async () => repairParent,
      });
      assert.deepEqual(result.child.events, repaired.events);
      assert.deepEqual(observed, [
        { sessionId: "child", startIndex: 0 },
        { sessionId: "child", startIndex: 10 },
        { sessionId: "child", startIndex: 20 },
      ]);
    });
  });
}

test("cleanup failure retains a lock that identifies the source backup", async (t) => {
  const root = await temporaryCheckout(t, "eve-selfmod-cleanup-failed-");
  await writeFile(join(root, "agent", "instructions.md"), "baseline");
  const target = targetFor();
  target.fetch = async (path) =>
    path.includes("/suspend?")
      ? new Response("no", { status: 500 })
      : response({ revision: "revision" });
  await assert.rejects(
    withSelfModification(context(target), async (harness) => {
      await harness.writeSource("instructions.md", "changed");
    }),
    /suspend.*failed: 500/,
  );
  const owner = JSON.parse(
    await readFile(join(root, ".eve-self-modification-eval.lock", "owner.json"), "utf8"),
  );
  t.after(() => rm(owner.backupRoot, { recursive: true, force: true }));
  assert.equal(
    await readFile(join(owner.backupRoot, "agent", "instructions.md"), "utf8"),
    "baseline",
  );
});
