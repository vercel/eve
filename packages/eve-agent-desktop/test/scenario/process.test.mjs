// The process runner against real processes, with eve's abort binding in place:
// the stop a cancelled call reports has to be a stop that happened, and the
// report has to say what could and could not be observed.
import assert from "node:assert/strict";
import test from "node:test";

import { bindCallAbort, createProcessSandbox } from "../support/process-sandbox.mjs";

const { runCommand } = await import("../../dist/sandbox/process.js");
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (child) => child.exitCode !== null || child.signalCode !== null;
const streamOf = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

test("the report waits for the exit after the kill is accepted", async () => {
  const events = [];
  let exited;
  // eve memoizes the exit it hands back, so both the caller and the stop see one promise.
  const wait = () =>
    (exited ??= (async () => {
      await tick(30);
      events.push("exited");
      return { exitCode: 0 };
    })());
  const sandbox = {
    spawn: async () => ({
      stdout: streamOf(""),
      stderr: streamOf(""),
      wait,
      kill: async () => events.push("killed"),
    }),
  };
  const controller = new AbortController();
  const call = runCommand(sandbox, "x", controller.signal);
  await tick(5);
  controller.abort(new Error("cancelled"));
  const error = await call.then(
    () => undefined,
    (rejection) => rejection,
  );
  assert.match(error.message, /cancelled Its command exited/);
  assert.deepEqual(
    events,
    ["killed", "exited"],
    "the call reported before the command's exit was seen",
  );
});

for (const reason of [
  new Error("cancelled during spawn"),
  new DOMException("deadline", "TimeoutError"),
]) {
  test(`a delayed spawn cannot launch after ${reason.name}`, async () => {
    const ready = Promise.withResolvers();
    const controller = new AbortController();
    let launched = false;
    const sandbox = {
      async spawn({ signal }) {
        await ready.promise;
        signal?.throwIfAborted();
        launched = true;
        return {
          stdout: streamOf(""),
          stderr: streamOf(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
        };
      },
    };
    const call = runCommand(sandbox, "command", controller.signal);
    controller.abort(reason);
    ready.resolve();
    await assert.rejects(
      call,
      reason.name === "TimeoutError" ? /ran out of its 300s budget/ : /cancelled during spawn/,
    );
    assert.equal(
      launched,
      false,
      "the provider must receive cancellation before starting the command",
    );
  });
}

test("collects stdout, stderr and the exit code of a finished command", async () => {
  const sandbox = createProcessSandbox();
  const result = await runCommand(sandbox, "echo out; echo err >&2; exit 7");
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout?.trim(), "out");
  assert.equal(result.stderr?.trim(), "err");
});

test(
  "a real command exceeding the output budget is stopped before rejection",
  { timeout: 5000 },
  async (t) => {
    const sandbox = createProcessSandbox();
    t.after(() => {
      for (const child of sandbox.children) if (!gone(child)) child.kill("SIGKILL");
    });
    await assert.rejects(
      runCommand(sandbox, "node -e 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 120))'"),
      /8 MiB combined stdout\/stderr limit/,
    );
    assert.ok(
      gone(sandbox.children.at(-1)),
      "the command must be stopped before the error is returned",
    );
  },
);

test("a cancelled command is dead and its outcome reported before the call rejects", async () => {
  const sandbox = createProcessSandbox();
  const controller = new AbortController();
  const call = runCommand(bindCallAbort(sandbox, controller.signal), "sleep 30", controller.signal);
  await tick(50);
  controller.abort(new Error("cancelled mid-flight"));
  const error = await call.then(
    () => undefined,
    (rejection) => rejection,
  );
  assert.ok(error, "the call must reject when it is cancelled");
  assert.match(error.message, /cancelled mid-flight/);
  assert.match(error.message, /was killed, but its exit could not be observed/);
  assert.match(error.message, /Read the live state/);
  assert.ok(
    gone(sandbox.children.at(-1)),
    "the call reported failure while its command was still alive",
  );
});

test("a command that finishes as the abort arrives is never reported as a success", async () => {
  const sandbox = createProcessSandbox();
  const controller = new AbortController();
  const call = runCommand(bindCallAbort(sandbox, controller.signal), "exit 0", controller.signal);
  controller.abort(new Error("cancelled late"));
  const error = await call.then(
    () => undefined,
    (rejection) => rejection,
  );
  assert.match(error.message, /cancelled late/);
  assert.match(error.message, /Read the live state/);
  assert.ok(gone(sandbox.children.at(-1)));
});

test("a signal that fires before the command starts never runs it", async () => {
  const sandbox = createProcessSandbox();
  const controller = new AbortController();
  controller.abort(new Error("cancelled first"));
  await assert.rejects(
    () =>
      runCommand(
        bindCallAbort(sandbox, controller.signal),
        "touch /tmp/agent-desktop-eve-should-not-exist",
        controller.signal,
      ),
    /cancelled first/,
  );
  assert.equal(sandbox.children.length, 0);
});

test("a budget that runs out reports the budget, not the sandbox's abort reason", async () => {
  const sandbox = createProcessSandbox();
  const signal = AbortSignal.timeout(120);
  const call = runCommand(bindCallAbort(sandbox, signal), "sleep 30", signal);
  const error = await call.then(
    () => undefined,
    (rejection) => rejection,
  );
  assert.match(error.message, /ran out of its 300s budget/);
  assert.match(error.message, /Read the live state/);
  assert.ok(gone(sandbox.children.at(-1)));
});
