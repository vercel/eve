import type { MockModelRequest, MockModelResponse, MockModelToolCall } from "eve/evals";

/** What people say in the hitl evals. Each sentence selects one script below. */
export const SAY = {
  changeA: "Alice asks for change A.",
  changesAB: "Alice asks for changes A and B together.",
  changeAAndAuthorized: "Alice asks for change A and an authorized change together.",
  authorized: "Alice asks for an authorized change.",
  oauthChecked: "Alice asks for an OAuth-checked change.",
  firstEcho: "Alice asks for a guarded echo of the first note.",
  secondEcho: "Alice asks for a guarded echo of the second note.",
  callerAccess: "Alice asks to check release access.",
  releaseGrant: "Alice asks Bob to grant her release access.",
  frozen: "Alice asks for the frozen change.",
  retiring: "Alice asks for the retiring change.",
  checkAccess: "Alice asks to check her Fixture Auth access.",
  checkAndPublish: "Alice asks to check her access and publish the draft together.",
  publish: "Alice asks to publish the draft.",
  hello: "Alice changes her mind and asks for a short hello instead.",
  dropB: "Alice says change B is no longer needed.",
  bobStatus: "Bob asks for a status update.",
  bobSpeakers: "Bob adds a note and asks who is speaking.",
  bobCallerToken: "Bob adds that the release should go out with Alice's release token.",
  bobReleaseNote: "Bob adds that the release note should be posted now.",
  aliceBobToken: "Alice asks for a release with Bob's release token.",
  spendBudget: "Alice spends the remaining budget on a summary.",
  statusNote: "Alice asks for a status note.",
  deadline: "Alice adds that the note should mention the deadline.",
} as const;

export const REPLY = {
  hello: "Hello, Alice.",
  droppedB: "Dropped change B.",
  bobStatus: "Bob's status update is ready.",
  summary: "Summary written.",
  statusNote: "Status note ready.",
  statusNoteWithDeadline: "Status note ready. It mentions the deadline.",
  staleAnswer: "Noted your earlier answer; it authorized nothing.",
} as const;

const STALE_ANSWER_PREFIX =
  "The user submitted the following response to an earlier interactive prompt.";
const TASK_RESULT = /<task_result id="[^"]+" tool="([^"]+)" status="([^"]+)">/gu;

/** The reply to `task.result` messages: each task's tool and status. */
export function taskResultsReply(results: readonly (readonly [tool: string, status: string])[]) {
  return `Task results: ${results.map(([tool, status]) => `${tool} ${status}`).join(", ")}.`;
}

/** Each attempt at a scripted call gets a new id, as a provider's would: `<id>.<attempt>`. */
let attempts = 0;
const call = (id: string, name: string, input: object = {}): MockModelToolCall => ({
  id: `${id}.${++attempts}`,
  input,
  name,
});

/**
 * Scripted model for `evals/hitl`. The newest message with a script
 * drives the step; tool results, not a counter, select the next response, so
 * durable replay follows the same script.
 */
export function respond(request: MockModelRequest): MockModelResponse {
  // A call is known by its script id; the attempt suffix only keeps call ids unique.
  const result = (id: string) =>
    request.toolResults.find((entry) => entry.id.slice(0, entry.id.lastIndexOf(".")) === id);
  const outcome = (id: string): string => {
    const found = result(id);
    if (found === undefined) return "missing";
    return found.isError ? "not run" : `done ${JSON.stringify(found.output)}`;
  };
  const run = (calls: MockModelToolCall[], answer: () => string): MockModelResponse => {
    const missing = calls.filter((tool) => result(scriptId(tool.id!)) === undefined);
    return missing.length > 0 ? { toolCalls: missing } : { text: answer() };
  };
  const scripts: Record<string, () => MockModelResponse> = {
    [SAY.changeA]: () => run([call("a", "change-a")], () => `Change A: ${outcome("a")}.`),
    [SAY.changesAB]: () =>
      run(
        [call("a", "change-a"), call("b", "change-b")],
        () => `Change A: ${outcome("a")}. Change B: ${outcome("b")}.`,
      ),
    [SAY.changeAAndAuthorized]: () =>
      run(
        [call("a", "change-a"), call("auth", "authorized-change")],
        () => `Change A: ${outcome("a")}. Authorized change: ${outcome("auth")}.`,
      ),
    [SAY.authorized]: () =>
      run([call("auth", "authorized-change")], () => `Authorized change: ${outcome("auth")}.`),
    [SAY.oauthChecked]: () =>
      run(
        [call("oauth", "oauth-authorized-gate", { marker: "hitl" })],
        () => `OAuth-checked change: ${outcome("oauth")}.`,
      ),
    [SAY.firstEcho]: () =>
      run(
        [call("echo-first", "guarded-echo", { note: "first" })],
        () => `First echo: ${outcome("echo-first")}.`,
      ),
    [SAY.secondEcho]: () =>
      run(
        [call("echo-second", "guarded-echo", { note: "second" })],
        () => `Second echo: ${outcome("echo-second")}.`,
      ),
    [SAY.callerAccess]: () =>
      run(
        [call("caller-access", "caller-access")],
        () => `Release access: ${outcome("caller-access")}.`,
      ),
    [SAY.releaseGrant]: () =>
      run(
        [call("release-grant", "release-grant")],
        () => `Release grant: ${outcome("release-grant")}.`,
      ),
    [SAY.frozen]: () =>
      run([call("frozen", "frozen-change")], () => `Frozen change: ${outcome("frozen")}.`),
    [SAY.retiring]: () =>
      run([call("retiring", "retiring-change")], () => `Retiring change: ${outcome("retiring")}.`),
    [SAY.checkAccess]: () =>
      run(
        [call("probe", "auth-probe", { marker: "hitl" })],
        () => `Access check: ${outcome("probe")}.`,
      ),
    [SAY.publish]: () =>
      run([call("publish", "publish-draft")], () => `Publish: ${outcome("publish")}.`),
    [SAY.checkAndPublish]: () =>
      run(
        [call("probe", "auth-probe", { marker: "hitl" }), call("publish", "publish-draft")],
        () => `Access check: ${outcome("probe")}. Publish: ${outcome("publish")}.`,
      ),
    [SAY.hello]: () => ({ text: REPLY.hello }),
    // Drops change B, which waits for its approval as a task, by the id its receipt names.
    [SAY.dropB]: () =>
      run(
        [call("drop-b", "eve__task_cancel", { taskId: receiptTaskId(result("b")?.output) })],
        () => REPLY.droppedB,
      ),
    [SAY.bobStatus]: () => ({ text: REPLY.bobStatus }),
    [SAY.bobSpeakers]: () =>
      run([call("speakers", "speakers")], () => `Speakers: ${outcome("speakers")}.`),
    [SAY.bobCallerToken]: () =>
      run(
        [call("caller-token", "caller-token")],
        () => `Caller token: ${outcome("caller-token")}.`,
      ),
    [SAY.bobReleaseNote]: () =>
      run(
        [call("release-note", "release-note")],
        () => `Release note: ${outcome("release-note")}.`,
      ),
    [SAY.aliceBobToken]: () =>
      run(
        [call("named-token", "named-token", { as: "bob" })],
        () => `Bob's token: ${outcome("named-token")}.`,
      ),
    [SAY.spendBudget]: () => ({
      text: REPLY.summary,
      usage: { inputTokens: 1, outputTokens: 1_000_000 },
    }),
    [SAY.statusNote]: () => ({
      text: request.userMessages.includes(SAY.deadline)
        ? REPLY.statusNoteWithDeadline
        : REPLY.statusNote,
    }),
  };
  scripts[SAY.deadline] = scripts[SAY.statusNote]!;

  // A call that waited on a person as a task reports in a `task.result` message once it runs or
  // is denied; `userMessages` leaves those out, and the `[Tasks]` note follows them.
  const latest = [...request.messages]
    .reverse()
    .find((message) => message.role === "user" && !message.text.startsWith("[Tasks]"));
  const results = [...(latest?.text.matchAll(TASK_RESULT) ?? [])].map(
    ([, tool, status]) => [tool!, status!] as const,
  );
  if (results.length > 0) return reply({ text: taskResultsReply(results) });

  for (const message of [...request.userMessages].reverse()) {
    if (message.startsWith(STALE_ANSWER_PREFIX)) return reply({ text: REPLY.staleAnswer });
    const script = scripts[message];
    if (script !== undefined) return reply(script());
  }
  throw new Error(`No hitl script for: ${JSON.stringify(request.userMessages)}`);
}

/** The task id a waiting call's receipt names. */
function receiptTaskId(output: unknown): string | undefined {
  return /Started task ([\w-]+)\./u.exec(JSON.stringify(output ?? ""))?.[1];
}

function scriptId(id: string): string {
  return id.slice(0, id.lastIndexOf("."));
}

function reply(response: MockModelResponse): MockModelResponse {
  return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
}
