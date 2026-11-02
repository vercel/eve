import assert from "node:assert/strict";
import test from "node:test";

const { runCommand } = await import("../dist/sandbox/process.js");
const BLOCK_BYTES = 512 * 1024;

function finiteStream(block, count, { hangOnCancel = false } = {}) {
  const state = { pulls: 0, cancelled: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (state.pulls === count) controller.close();
        else {
          state.pulls++;
          controller.enqueue(block);
        }
      },
      cancel() {
        state.cancelled++;
        if (hangOnCancel) return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

for (const [name, counts, killFails] of [
  ["stdout", [18, 64], false],
  ["stderr", [64, 18], true],
  ["combined streams", [10, 10], false],
]) {
  test(
    `excess ${name} cancels both readers and reports a bounded error after stopping`,
    { timeout: 2000 },
    async () => {
      const block = new Uint8Array(BLOCK_BYTES).fill(120);
      const stdout = finiteStream(name === "stderr" ? new Uint8Array([121]) : block, counts[0], {
        hangOnCancel: true,
      });
      const stderr = finiteStream(name === "stdout" ? new Uint8Array([121]) : block, counts[1], {
        hangOnCancel: true,
      });
      let killed = 0;
      const sandbox = {
        spawn: async () => ({
          stdout: stdout.stream,
          stderr: stderr.stream,
          wait: async () => ({ exitCode: 0 }),
          async kill() {
            await Promise.resolve();
            killed++;
            if (killFails) throw new Error("kill refused");
          },
        }),
      };
      await assert.rejects(runCommand(sandbox, "bounded fixture"), (error) => {
        assert.match(error.message, /8 MiB combined stdout\/stderr limit/);
        assert.match(error.message, killFails ? /could not be stopped/ : /command exited/);
        assert.match(error.message, /Read the live state/);
        assert.ok(error.message.length < 1024);
        assert.ok(!error.message.includes("x".repeat(100)));
        assert.equal(killed, 1, "termination must be attempted before reporting the limit");
        return true;
      });
      assert.equal(stdout.state.cancelled, 1);
      assert.equal(stderr.state.cancelled, 1);
      assert.ok(stdout.state.pulls < counts[0]);
      assert.ok(stderr.state.pulls < counts[1]);
    },
  );
}

test("accepts exactly 8 MiB combined output and counts UTF-8 bytes, not characters", async () => {
  const block = new TextEncoder().encode("é".repeat(BLOCK_BYTES / 2));
  let killed = false;
  const sandbox = {
    spawn: async () => ({
      stdout: finiteStream(block, 8).stream,
      stderr: finiteStream(block, 8).stream,
      wait: async () => ({ exitCode: 7 }),
      kill: async () => {
        killed = true;
      },
    }),
  };
  const result = await runCommand(sandbox, "bounded fixture");
  assert.equal(result.stdout.length, 2 * 1024 * 1024);
  assert.equal(result.stderr.length, 2 * 1024 * 1024);
  assert.equal(result.stdout.slice(-1), "é");
  assert.equal(result.exitCode, 7);
  assert.equal(killed, false);
});

test("decodes UTF-8 characters split across output chunks", async () => {
  const bytes = [0xe2, 0x82, 0xac];
  const sandbox = {
    spawn: async () => ({
      stdout: new ReadableStream({
        pull(controller) {
          const byte = bytes.shift();
          if (byte === undefined) controller.close();
          else controller.enqueue(new Uint8Array([byte]));
        },
      }),
      stderr: new Response("").body,
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    }),
  };
  assert.equal((await runCommand(sandbox, "bounded fixture")).stdout, "€");
});
