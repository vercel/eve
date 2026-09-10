import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const origin = process.env.A2A_ORIGIN ?? "http://localhost:4317";
const authorization = `Basic ${Buffer.from(`alice:${process.env.A2A_DEMO_PASSWORD ?? "prototype-only"}`).toString("base64")}`;
const headers = { authorization, "content-type": "application/json", "a2a-version": "1.0" };
const message = (text, taskId) => ({
  message: {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...(taskId ? { taskId } : {}),
  },
});
const terminal = (task) =>
  [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(task.status.state);

async function rpc(method, params, extraHeaders = {}) {
  const response = await fetch(`${origin}/a2a`, {
    method: "POST",
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function eventually(read, accept, label) {
  const deadline = Date.now() + 45_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error(`${label}: ${JSON.stringify(value).slice(-6000)}`);
}
const getTask = async (id) => {
  const response = await rpc("GetTask", { id });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
};
async function start(text) {
  const response = await rpc("SendMessage", {
    ...message(text),
    configuration: { returnImmediately: true },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result.task;
}
async function demo(text) {
  const response = await fetch(`${origin}/demo`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: text }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).id;
}
async function events(id) {
  const response = await fetch(`${origin}/demo/${encodeURIComponent(id)}/events`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}
async function callTool(tool, input) {
  const id = await demo(`CALL ${JSON.stringify({ tool, input })}`);
  const list = await eventually(
    () => events(id),
    (list) => list.some((event) => event.type === "action.result"),
    `tool ${tool}`,
  );
  const result = list.find((event) => event.type === "action.result");
  assert.equal(result.data.status, "completed", JSON.stringify(result));
  return result.data.result.output;
}

const card = await (await fetch(`${origin}/.well-known/agent-card.json`)).json();
assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
assert.deepEqual(card.securityRequirements, [{ schemes: { basic: { list: [] } } }]);
assert.equal((await fetch(`${origin}/a2a`, { method: "POST", body: "{}" })).status, 401);
assert.equal((await rpc("GetTask", { id: "missing" })).error.code, -32001);
assert.equal(
  (await rpc("GetTask", { id: "missing" }, { "a2a-version": "0.3" })).error.code,
  -32009,
);
console.log("PASS discovery, authentication, unknown task, version negotiation");

const started = await start("REMOTE hello");
assert.equal(started.status.state, "TASK_STATE_SUBMITTED");
const complete = await eventually(() => getTask(started.id), terminal, "echo completion");
assert.equal(complete.status.state, "TASK_STATE_COMPLETED");
assert.match(JSON.stringify(complete.artifacts), /Echo: hello/);
const bob = `Basic ${Buffer.from(`bob:${process.env.A2A_OTHER_PASSWORD ?? "other-prototype-only"}`).toString("base64")}`;
assert.equal((await rpc("GetTask", { id: started.id }, { authorization: bob })).error.code, -32001);
assert.equal((await rpc("CancelTask", { id: started.id })).error.code, -32002);
assert.equal((await rpc("SendMessage", message("again", started.id))).error.code, -32004);
console.log("PASS asynchronous completion, owner isolation, terminal task immutability");

const question = await rpc("SendMessage", message("REMOTE ask"));
assert.equal(question.error, undefined, JSON.stringify(question));
assert.equal(question.result.task.status.state, "TASK_STATE_INPUT_REQUIRED");
const replied = await rpc("SendMessage", message("Lisbon", question.result.task.id));
assert.equal(replied.error, undefined, JSON.stringify(replied));
assert.equal(replied.result.task.id, question.result.task.id);
assert.equal(replied.result.task.status.state, "TASK_STATE_COMPLETED");
assert.match(JSON.stringify(replied.result.task.artifacts), /Lisbon/);
console.log("PASS blocking send, interrupted task, reply on the same task");

const waiting = await start("REMOTE wait 30");
const cancelled = await rpc("CancelTask", { id: waiting.id });
assert.equal(cancelled.error, undefined, JSON.stringify(cancelled));
assert.equal(cancelled.result.status.state, "TASK_STATE_CANCELED");
console.log("PASS explicit remote cancellation during a durable wait");

const sse = await fetch(`${origin}/a2a`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "SendStreamingMessage",
    params: message("REMOTE wait 2"),
  }),
  signal: AbortSignal.timeout(45_000),
});
assert.match(sse.headers.get("content-type"), /text\/event-stream/);
const frames = (await sse.text())
  .split("\n\n")
  .filter(Boolean)
  .map((frame) => JSON.parse(frame.slice(6)).result);
assert.ok(frames[0].task);
assert.ok(frames.some((frame) => frame.artifactUpdate));
assert.equal(frames.at(-1).statusUpdate.status.state, "TASK_STATE_COMPLETED");
console.log("PASS SSE initial task, artifact, and terminal status");

const subscribed = await start("REMOTE wait 2");
const subscription = await fetch(`${origin}/a2a`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "SubscribeToTask",
    params: { id: subscribed.id },
  }),
  signal: AbortSignal.timeout(45_000),
});
const subscriptionText = await subscription.text();
assert.match(subscriptionText, /TASK_STATE_COMPLETED/);
assert.match(subscriptionText, /artifactUpdate/);
console.log("PASS subscription resumes from the task snapshot");

const parent = await demo("DELEGATE wait 3");
const parentEvents = await eventually(
  () => events(parent),
  (list) => JSON.stringify(list).includes("TASK_STATE_COMPLETED"),
  "background delegation",
);
const resultEvents = parentEvents.filter((event) => event.type === "action.result");
assert.ok(
  JSON.stringify(resultEvents).includes("working"),
  "parent must receive a background receipt",
);
assert.match(JSON.stringify(parentEvents), /Finished:/);
console.log(
  "PASS model calls authored A2A workflow tool, receives receipt, and receives remote completion",
);

const asking = await callTool("a2a__send", { message: "REMOTE ask" });
await eventually(
  () => getTask(asking.id),
  (task) => task.status.state === "TASK_STATE_INPUT_REQUIRED",
  "remote question",
);
const watcher = await demo(
  `CALL ${JSON.stringify({ tool: "a2a_delegate", input: { taskId: asking.id } })}`,
);
await eventually(
  () => events(watcher),
  (list) => JSON.stringify(list).includes("needs input"),
  "watcher reports question",
);
const reply = await callTool("a2a__send", { taskId: asking.id, message: "Porto" });
assert.equal(reply.id, asking.id);
await eventually(
  () => events(watcher),
  (list) => JSON.stringify(list).includes("TASK_STATE_COMPLETED"),
  "watcher completes after independent reply",
);
const inspected = await callTool("a2a__get", { taskId: asking.id });
assert.match(JSON.stringify(inspected.artifacts), /Porto/);
const longTask = await callTool("a2a__send", { message: "REMOTE wait 30" });
const stopped = await callTool("a2a__cancel", { taskId: longTask.id });
assert.equal(stopped.status.state, "TASK_STATE_CANCELED");
console.log("PASS authored send/get/cancel tools and reply to a task with an active watcher");
console.log(JSON.stringify({ completedTaskId: started.id, parentId: parent }));
