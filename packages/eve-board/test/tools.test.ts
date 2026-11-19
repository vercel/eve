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
  defineBoardScheduleTool,
  defineBoardTypingTool,
} from "../extension/lib/tools.ts";
import { runTool, startBoard } from "./helpers.ts";

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

  assert.deepEqual(
    await run(defineBoardTypingTool(settings), { id: root.id, status: "Checking" }, "call-5"),
    { ok: true },
  );
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
