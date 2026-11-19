import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defineBoardChannelsTool,
  defineBoardCompleteTaskTool,
  defineBoardCreateTaskTool,
  defineBoardFailTaskTool,
  defineBoardLabelTool,
  defineBoardNoteTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardReplyTool,
  defineBoardActorsTool,
  defineBoardBlockTaskTool,
  defineBoardCancelScheduleTool,
  defineBoardReactTool,
  defineBoardScheduleTool,
  defineBoardSchedulesTool,
  defineBoardUnwatchTool,
  defineBoardWatchesTool,
  defineBoardWatchTool,
  holdsTask,
} from "../extension/lib/tools.ts";
import { withHints } from "../extension/lib/client.ts";
import { accepts, runTool, startBoard } from "./helpers.ts";

const settings = () => ({ profile: "helper" });
const files = new Map([["/workspace/after.png", new Uint8Array([137, 80, 78, 71])]]);
const run = (tool: unknown, input: unknown, callId: string, metadata: unknown = {}) =>
  runTool(tool, input, { callId, files, metadata });

test("the board tools post once per call, reply, label, and read back as the agent's profile", async () => {
  await startBoard();
  const post = defineBoardPostTool(settings);

  const root = await run(post, { channel: "dev", text: "Deploy checklist" }, "call-1");
  const retried = await run(post, { channel: "dev", text: "Deploy checklist" }, "call-1");
  assert.equal(retried.id, root.id);
  assert.equal(root.author, "eve/helper");

  await run(defineBoardReplyTool(settings), { id: root.id, text: "Migrations ran." }, "call-2");
  await run(defineBoardLabelTool(settings), { id: root.id, set: { status: "done" } }, "call-3");

  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "call-4");
  assert.deepEqual(thread.message.labels, { status: "done" });
  assert.deepEqual(
    thread.replies.map((reply: { text: string }) => reply.text),
    ["Migrations ran."],
  );

  const listed = await run(defineBoardReadTool(settings), { channel: "dev" }, "call-5");
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].replies, 1);

  const { channels } = await run(defineBoardChannelsTool(settings), {}, "call-6");
  assert.deepEqual(channels, [{ path: "dev" }]);
});

test("a reply attaches files from the sandbox and warns about mentions that notified no one", async () => {
  await startBoard();
  const root = await run(
    defineBoardPostTool(settings),
    { channel: "dev", text: "Fix the header" },
    "call-1",
  );
  const reply = defineBoardReplyTool(settings);

  const shot = await run(reply, { id: root.id, attach: ["/workspace/after.png"] }, "call-2");
  assert.deepEqual(shot.attachments, ["after.png"]);
  assert.equal(shot.warning, undefined);

  await assert.rejects(
    run(
      reply,
      { id: root.id, text: "and", attach: ["/workspace/after.png", "/nope.txt"] },
      "call-3",
    ),
    /There is no file at \/nope\.txt in the sandbox/u,
  );

  const mention = await run(reply, { id: root.id, text: "Done, @nobody" }, "call-4");
  assert.deepEqual(mention.unknownMentions, ["nobody"]);
  assert.match(mention.warning, /@nobody matched no one/u);

  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "call-6");
  assert.equal(thread.replies.length, 2);
});

test("notes and schedules default to the session's own thread", async () => {
  await startBoard();
  const root = await run(defineBoardPostTool(settings), { channel: "dev", text: "Ship it" }, "c1");
  const session = { boardThread: root.id };

  const note = await run(
    defineBoardNoteTool(settings),
    { text: "Tried the cache." },
    "c2",
    session,
  );
  assert.equal(note.re, root.id);
  const schedule = await run(
    defineBoardScheduleTool(settings),
    { in: "5m", text: "Check CI for the deploy." },
    "c3",
    session,
  );
  assert.equal(schedule.thread, root.id);
  assert.ok(schedule.next);

  await assert.rejects(
    run(defineBoardNoteTool(settings), { text: "Nowhere." }, "c4"),
    /Pass the thread's `id`/u,
  );
});

test("task tools create a task, and settle tools name the claim the session holds", async () => {
  await startBoard();
  const created = await run(
    defineBoardCreateTaskTool(settings),
    { channel: "work/a", labels: { role: "review" }, text: "Review the limiter." },
    "c1",
  );
  assert.equal(created.task.state, "ready");

  const until = new Date(Date.now() + 60_000).toISOString();
  const held = { boardTask: { id: created.id, until } };
  assert.deepEqual(
    await run(defineBoardCompleteTaskTool(settings), { result: "Looks right." }, "c2", held),
    { result: "Looks right.", settled: "completed", task: created.id },
  );
  assert.deepEqual(
    await run(defineBoardFailTaskTool(settings), { reason: "Too late." }, "c3", held),
    { reason: "Too late.", settled: "failed", task: created.id },
  );
  await assert.rejects(
    run(defineBoardFailTaskTool(settings), { reason: "Too late." }, "c4", {
      boardTask: { id: created.id, until: new Date(Date.now() - 1_000).toISOString() },
    }),
    /You no longer hold board task/u,
  );
  await assert.rejects(
    run(defineBoardCompleteTaskTool(settings), {}, "c5"),
    /This session holds no board task/u,
  );
});

test("read pages a channel by its cursor, and reads only the replies after a message", async () => {
  await startBoard();
  const post = defineBoardPostTool(settings);
  const read = defineBoardReadTool(settings);
  await run(post, { channel: "dev", text: "First" }, "p1");
  const first = await run(read, { channel: "dev" }, "r1");
  assert.deepEqual(
    first.threads.map((thread: { message: { text: string } }) => thread.message.text),
    ["First"],
  );
  await run(post, { channel: "dev", text: "Second" }, "p2");
  const since = await run(read, { after: first.cursor, channel: "dev" }, "r2");
  assert.deepEqual(
    since.threads.map((thread: { message: { text: string } }) => thread.message.text),
    ["Second"],
  );

  const root = await run(post, { channel: "dev", text: "Thread" }, "p3");
  const reply = defineBoardReplyTool(settings);
  const one = await run(reply, { id: root.id, text: "One" }, "p4");
  await run(reply, { id: root.id, text: "Two" }, "p5");
  const newer = await run(read, { after: one.id, id: root.id }, "r3");
  assert.deepEqual(
    newer.replies.map((message: { text: string }) => message.text),
    ["Two"],
  );
  await assert.rejects(run(read, {}, "r4"), /Pass `id`, `link`, or `channel`/u);
});

test("a reply with `after` refuses when the thread moved on, and a label change checks its condition", async () => {
  await startBoard();
  const root = await run(defineBoardPostTool(settings), { channel: "dev", text: "Ship it?" }, "p1");
  const reply = defineBoardReplyTool(settings);
  const answer = await run(reply, { id: root.id, text: "Tests pass." }, "p2");
  await assert.rejects(run(reply, { after: root.id, id: root.id, text: "Shipping." }, "p3"), {
    code: "newer_message",
  });
  await run(reply, { after: answer.id, id: root.id, text: "Shipping." }, "p4");

  const label = defineBoardLabelTool(settings);
  await run(label, { id: root.id, set: { status: "open" } }, "l1");
  await assert.rejects(
    run(label, { id: root.id, if: { status: "closed" }, set: { status: "done" } }, "l2"),
  );
  await run(label, { id: root.id, if: { status: "open" }, set: { status: "done" } }, "l3");
  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "r1");
  assert.equal(thread.message.labels.status, "done");
});

test("schedules lists the session's check-ins, and actors finds handles to mention", async () => {
  const { as } = await startBoard();
  const root = await run(defineBoardPostTool(settings), { channel: "dev", text: "CI" }, "p1");
  const thread = { boardThread: root.id };
  const scheduled = await run(
    defineBoardScheduleTool(settings),
    { in: "1h", text: "Check CI." },
    "s1",
    thread,
  );
  const listed = await run(defineBoardSchedulesTool(settings), {}, "s2", thread);
  assert.deepEqual(
    listed.schedules.map((schedule: { id: string }) => schedule.id),
    [scheduled.id],
  );

  await as("alice", "/messages", { channel: "dev", text: "Hi." });
  const found = await run(defineBoardActorsTool(settings), { search: "ali" }, "a1");
  assert.deepEqual(
    found.actors.map((actor: { handle: string }) => actor.handle),
    ["alice"],
  );
});

test("rare tools are deferred, and task tools are offered only while the session holds a task", () => {
  const deferred = (tool: unknown) => (tool as { deferred?: boolean }).deferred === true;
  for (const define of [
    defineBoardNoteTool,
    defineBoardLabelTool,
    defineBoardScheduleTool,
    defineBoardCancelScheduleTool,
    defineBoardSchedulesTool,
    defineBoardChannelsTool,
    defineBoardActorsTool,
    defineBoardCreateTaskTool,
    defineBoardWatchTool,
    defineBoardWatchesTool,
    defineBoardUnwatchTool,
  ]) {
    assert.equal(deferred(define(settings)), true, define.name);
  }
  for (const define of [
    defineBoardReadTool,
    defineBoardReplyTool,
    defineBoardPostTool,
    defineBoardReactTool,
    defineBoardCompleteTaskTool,
    defineBoardBlockTaskTool,
    defineBoardFailTaskTool,
  ]) {
    assert.equal(deferred(define(settings)), false, define.name);
  }
  const until = new Date(Date.now() + 60_000).toISOString();
  assert.equal(holdsTask({ channel: { metadata: { boardTask: { id: "7", until } } } }), true);
  assert.equal(holdsTask({ channel: { metadata: { boardTask: null } } }), false);
  assert.equal(holdsTask({}), false);
});

test("board errors carry the board's hint in their message and keep their code", async () => {
  const failure = () =>
    Object.assign(new Error("The task is claimed."), {
      code: "task_claimed",
      hint: "Claim another with `claim --ready`.",
    });
  const handle = withHints({
    async claim() {
      throw failure();
    },
    tasks: {
      held() {
        return {
          async renew() {
            throw failure();
          },
        };
      },
    },
  });
  for (const act of [() => handle.claim(), () => handle.tasks.held().renew()]) {
    await assert.rejects(act(), {
      code: "task_claimed",
      message: "The task is claimed. Claim another with `claim --ready`.",
    });
  }
});

test("the task tools accept only results, reasons, and hold kinds the board stores", () => {
  const settings = () => ({});

  assert.equal(accepts(defineBoardCompleteTaskTool(settings), { result: "x".repeat(1_000) }), true);
  assert.equal(
    accepts(defineBoardCompleteTaskTool(settings), { result: "x".repeat(1_001) }),
    false,
  );
  assert.equal(accepts(defineBoardFailTaskTool(settings), { reason: "x".repeat(1_001) }), false);
  assert.equal(
    accepts(defineBoardBlockTaskTool(settings), { kind: "needs_input", reason: "Which region?" }),
    true,
  );
  assert.equal(
    accepts(defineBoardBlockTaskTool(settings), { kind: "Needs input", reason: "Which region?" }),
    false,
  );
});
