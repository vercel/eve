import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import type { SessionStreamEvent } from "eve/client";
import type { EveEvalContext, EveEvalLiveTurn } from "eve/evals";

/** A turn whose program waits on the sleeper, and the sleeper's own session. */
export interface ProgramOnSleeper {
  readonly child: EveEvalLiveTurn;
  readonly parent: EveEvalLiveTurn;
}

/**
 * Starts a turn whose scripted `eve__execute` program asks the sleeper, and returns once the
 * sleeper's session has called `tool`, the call that keeps it working.
 */
export async function startProgramOnSleeper(
  t: EveEvalContext,
  options: { readonly prompt: string; readonly tool: string },
): Promise<ProgramOnSleeper> {
  const session = await t.session();
  const parent = await session.start(options.prompt);
  const opened = await parent.waitForEvent("child.opened", { data: { name: "sleeper" } });
  const child = t.target.attach(opened.data.sessionId).watch();
  await child.waitForEvent("call.requested", { data: { capability: { name: options.tool } } });
  return { child, parent };
}

/** The task the program run by `programCall` became when a new message moved it to the background. */
export function backgroundTaskOf(
  events: readonly SessionStreamEvent[],
  programCall: string,
): string {
  for (const event of events) {
    if (
      event.type === "task.started" &&
      event.data.name === EXECUTE_TOOL &&
      event.data.startedBy.callId === programCall
    ) {
      return event.data.taskId;
    }
  }
  throw new Error(`The program "${programCall}" never moved to the background.`);
}
