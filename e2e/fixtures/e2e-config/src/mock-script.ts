// Helpers for scripted mock responders: a scenario is a fixed sequence of tool
// calls with stable ids, played one model step at a time.
import type { EveEvalContext, MockModelRequest, MockModelResponse } from "eve/evals";

import { CALL_TOOL, SKILL_TOOL } from "./catalog-tools";

/** One tool call of a scripted scenario. Its fixed id marks it as done once its result is in the prompt. */
export interface ScriptedCall {
  readonly id: string;
  readonly name: string;
  readonly input?: (request: MockModelRequest) => unknown;
}

/**
 * The id to emit for a scripted call. eve keeps a session's call ids unique, so a call one
 * conversation makes again, as after a sign-in drops the interrupted one from history, arrives
 * as `<id>#<n>`; {@link scriptedIdOf} reads the scripted id back.
 */
export function scriptedCallId(_request: MockModelRequest, id: string): string {
  return id;
}

/** The scripted id a call's id was emitted for. */
export function scriptedIdOf(callId: string): string {
  return callId.replace(/#\d+$/u, "");
}

/** The result of the scripted call `id`, whichever attempt produced it. */
export function resultOf(request: MockModelRequest, id: string) {
  return request.toolResults.find((entry) => scriptedIdOf(entry.id) === id);
}

/**
 * Plays a scenario one model step at a time: the first call without a result
 * runs next, and `finish` answers once every call has one.
 */
export function playScript(
  request: MockModelRequest,
  calls: readonly ScriptedCall[],
  finish: (request: MockModelRequest) => MockModelResponse | string,
): MockModelResponse | string {
  const done = new Set(request.toolResults.map((result) => scriptedIdOf(result.id)));
  const next = calls.find((call) => !done.has(call.id));
  if (next === undefined) return finish(request);
  return {
    toolCalls: [
      { id: scriptedCallId(request, next.id), input: next.input?.(request) ?? {}, name: next.name },
    ],
  };
}

/** A scripted `eve__tool` call: a catalog tool by name, with its input. */
export function callTool(id: string, name: string, input?: object): ScriptedCall {
  return { id, input: () => (input === undefined ? { name } : { input, name }), name: CALL_TOOL };
}

/** A scripted `eve__skill` call that loads the named skill. */
export function loadSkill(id: string, name: string): ScriptedCall {
  return { id, input: () => ({ name }), name: SKILL_TOOL };
}

/** Loads each named skill with `eve__skill({ name })`, then replies with each skill's last line. */
export function loadSkills(
  request: MockModelRequest,
  names: readonly string[],
): MockModelResponse | string {
  return playScript(
    request,
    names.map((skill) => loadSkill(`load-${skill}`, skill)),
    (finished) =>
      names.map((skill) => outputOf(finished, `load-${skill}`).trim().split("\n").at(-1)).join(" "),
  );
}

/** Skips an eval whose scripted calls only the deterministic mock model makes. */
export function requireMockModel(
  t: EveEvalContext,
  reason = "Requires the deterministic mock model to issue the exact calls.",
): void {
  if (process.env.EVE_E2E_MODEL !== "mock") t.skip(reason);
}

/** The output of the call with `id`, as the model sees it. */
export function outputOf(request: MockModelRequest, id: string): string {
  const result = resultOf(request, id);
  if (result === undefined) throw new Error(`The script expected a result for call "${id}".`);
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
}

/** The task a receipt names, such as `Started task revise_plan-7k2m9q.` */
export function taskIdFromReceipt(request: MockModelRequest, callId: string): string {
  const taskId = /Started task (\S+?)\.(?:\s|$)/u.exec(outputOf(request, callId))?.[1];
  if (taskId === undefined) throw new Error(`Call "${callId}" returned no task receipt.`);
  return taskId;
}

/** The body of the latest `<task_result>` block for `tool`, once a result has arrived. */
export function latestTaskResult(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(
    `<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`,
    "g",
  );
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const bodies = [...message.text.matchAll(pattern)].map((match) => match[1]!);
    if (bodies.length > 0) return bodies.at(-1);
  }
  return undefined;
}
