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
  frozen: "Alice asks for the frozen change.",
  retiring: "Alice asks for the retiring change.",
  checkAccess: "Alice asks to check her Fixture Auth access.",
  checkAndPublish: "Alice asks to check her access and publish the draft together.",
  publish: "Alice asks to publish the draft.",
  hello: "Alice changes her mind and asks for a short hello instead.",
  bobStatus: "Bob asks for a status update.",
  spendBudget: "Alice spends the remaining budget on a summary.",
  statusNote: "Alice asks for a status note.",
  deadline: "Alice adds that the note should mention the deadline.",
} as const;

export const REPLY = {
  hello: "Hello, Alice.",
  helloAfterAuthorization: "Hello, Alice. I dropped the authorization you no longer need.",
  bobStatus: "Bob's status update is ready.",
  summary: "Summary written.",
  statusNote: "Status note ready.",
  statusNoteWithDeadline: "Status note ready. It mentions the deadline.",
  staleAnswer: "Noted your earlier answer; it authorized nothing.",
} as const;

const STALE_ANSWER_PREFIX =
  "The user submitted the following response to an earlier interactive prompt.";
const SIGN_IN_DROPPED = "was cancelled because the user sent a new message instead";

const call = (id: string, name: string, input: object = {}): MockModelToolCall => ({
  id,
  input,
  name,
});

/**
 * Scripted model for `evals/hitl`. The newest message with a script
 * drives the step; tool results, not a counter, select the next response, so
 * durable replay follows the same script.
 */
export function respond(request: MockModelRequest): MockModelResponse {
  const result = (id: string) => request.toolResults.find((entry) => entry.id === id);
  const outcome = (id: string): string => {
    const found = result(id);
    if (found === undefined) return "missing";
    return found.isError ? "not run" : `done ${JSON.stringify(found.output)}`;
  };
  const run = (calls: MockModelToolCall[], answer: () => string): MockModelResponse => {
    const missing = calls.filter((tool) => result(tool.id!) === undefined);
    return missing.length > 0 ? { toolCalls: missing } : { text: answer() };
  };
  const allText = request.messages.map((message) => message.text).join("\n");

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
    [SAY.hello]: () => ({
      text: allText.includes(SIGN_IN_DROPPED) ? REPLY.helloAfterAuthorization : REPLY.hello,
    }),
    [SAY.bobStatus]: () => ({ text: REPLY.bobStatus }),
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

  for (const message of [...request.userMessages].reverse()) {
    if (message.startsWith(STALE_ANSWER_PREFIX)) return reply({ text: REPLY.staleAnswer });
    const script = scripts[message];
    if (script !== undefined) return reply(script());
  }
  throw new Error(`No hitl script for: ${JSON.stringify(request.userMessages)}`);
}

function reply(response: MockModelResponse): MockModelResponse {
  return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
}
