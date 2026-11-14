import type { RunInput, Runtime, SessionCommand } from "#channel/types.js";
import { activationLoop, untilQuiescent } from "#execution/actor/activation-loop.js";
import type { ActivationRun, Actors } from "#execution/actor/actors.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { WorkflowFunction } from "#execution/in-process/runs.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { createLogger } from "#internal/logging.js";

// One activation of one session on a World host: the session runs in this process until it
// waits on something to arrive or on a timer, then it's stopped, and its actor keeps it as it
// was (`#execution/actor`). The lifecycle is the actor layer's (`activationLoop`); what's a
// session's is how it resumes, takes a message, waits and stops:
//   1. A fresh in-process runtime continues the session from what its actor holds: its saved
//      state, or, for a session nothing ran yet, what it was created with (`SessionStart`). It
//      writes through the activation's handle, and reads none of its stream's lines, only how
//      many there are. What the restore started (its runs, a subagent's session) goes on to
//      where it was first.
//   2. What its mailbox holds is handed to the session's addresses, oldest first: a command as
//      its channel sends it, a payload as a callback route or another session resumes the
//      address. Keeping one as an input consumes it in the same write; one only the session's
//      memory takes (a callback) is consumed by its next save, or when it stops. So a crash hands
//      each message over until the session kept what it did with it.
//   3. The session runs: its turns, its subagents' sessions and its runs, all here. What arrives
//      meanwhile reaches it as it works: a sender hints the activation (`watchInbox`), which reads
//      its mailbox then. Once everything waits, and still waits once nothing is in flight for a
//      few macrotasks, it's stopped (suspended: nothing it holds is torn down), with its earliest
//      timer as the actor's alarm. A timer due in a moment is waited for.
//   4. Near the activation's deadline, it's stopped wherever a step ends, and the activation
//      continues: the next one goes on with it.

const log = createLogger("execution.world-host.driver");

/**
 * What a World host's session is sent: a command, as a channel sends one, or a payload for one of
 * its addresses, as a callback route or another session resumes it (`via` names the address).
 */
export type SessionMessage =
  | { readonly command: SessionCommand }
  /** Delivered at `token` when it names one (a run's hook), else at the address it was sent to. */
  | { readonly deliver: unknown; readonly token?: string };

/**
 * What a World host's session is created with: its actor's meta. A channel's start carries its
 * run input; a test's, the initial entry Workflow's `workflowEntry` takes.
 */
export type SessionStart = { readonly agent: string } & (
  | { readonly input: RunInput }
  | { readonly entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId"> }
);

export interface SessionActivationOptions {
  readonly world: RuntimeWorld;
  readonly actors: Actors;
  /** The agent named `name`, as a runtime runs it; `undefined` if unknown. */
  readonly agent: (name: string) => SessionRuntimeConfig | undefined;
  /** A timer due within this long is waited for, rather than set as the alarm. */
  readonly holdForTimerMs?: number;
  /** Where sign-in links send the provider back to (`WorldHostOptions.callbackBaseUrl`). */
  readonly callbackBaseUrl?: string;
  /** The host's runtime for the agent named `name`: where a step reaches other sessions. */
  readonly runtime?: (name: string) => Runtime;
  /** Starts a run of a workflow tool whose body this host doesn't hold. */
  readonly startDurableRun?: StartWorkflowToolRun;
  /** The plain bodies of authored workflow tools, which each activation's runtime runs. */
  readonly workflows?: () => ReadonlyMap<string, WorkflowFunction>;
  /** What else each activation's in-process runtime is made with (a test's step boundary, say). */
  readonly runtimeOptions?: Omit<
    InProcessRuntimeOptions,
    "world" | "worldStore" | "servesLines" | "runOwner"
  >;
}

/** What runs a session each time its actor is activated. */
export function sessionActivation(options: SessionActivationOptions): ActivationRun {
  return activationLoop(
    async (actor, { deadline }) => {
      const sessionId = actor.key;
      const start = actor.meta as Partial<SessionStart> | undefined;
      if (typeof start?.agent !== "string" || (!("input" in start) && !("entry" in start)))
        throw new Error(`Session "${sessionId}" wasn't started by a World host.`);
      const agentName = start.agent;
      const config = options.agent(agentName);
      if (config === undefined)
        throw new Error(
          `Session "${sessionId}" runs the agent "${agentName}", which this host doesn't have.`,
        );
      const store = createWorldSessionStore(options.world, {
        actors: options.actors,
        handles: (key) => (key === sessionId ? actor : undefined),
        root: sessionId,
      });
      const runtime = createInProcessRuntime(config, {
        ...options.runtimeOptions,
        servesLines: false,
        world: options.world,
        worldStore: store,
        ...(options.callbackBaseUrl !== undefined && { callbackBaseUrl: options.callbackBaseUrl }),
        ...(options.runtime !== undefined && { stepRuntime: () => options.runtime!(agentName) }),
        ...(options.startDurableRun !== undefined && { startDurableRun: options.startDurableRun }),
        runOwner: sessionId,
      });
      for (const [workflowId, body] of options.workflows?.() ?? [])
        runtime.registerWorkflow(workflowId, body);
      return {
        async resume() {
          const saved = await runtime.load(sessionId, { lines: "count" });
          if (saved !== undefined) {
            await runtime.restore(saved, { stored: true });
            // What it ran goes on to where it was (a subagent reopens its session) before
            // anything arrives: an answer the session forwards to a child finds the child here.
            await settledAfterRestore(runtime, deadline);
          } else if ("entry" in start && start.entry !== undefined)
            await runtime.startEntry(start.entry, sessionId);
          else if ("input" in start && start.input !== undefined)
            await runtime.startSession(sessionId, start.input);
        },
        async deliver(message) {
          // Keeping it as an input consumes it in the same write (`receive`); one it takes
          // without keeping is consumed by its next save, or when it stops (`flush`).
          store.receive(sessionId, message.id);
          const body = message.body as SessionMessage;
          const token = message.via ?? sessionCommandHookToken(sessionId);
          if ("deliver" in body) {
            const at = body.token ?? token;
            // No one here at its address: it's consumed with the rest, so say so.
            if ((await runtime.deliver(at, body.deliver)) === undefined)
              log.warn("a delivery found no one at its address", { sessionId, token: at });
          } else if (message.via === undefined)
            await runtime.dispatchSession({ command: body.command, sessionId });
          else
            await runtime.dispatchContinuation({ command: body.command, continuationToken: token });
          store.received(sessionId);
        },
        quiescent: () => runtime.quiescent(),
        idle: async () => await runtime.idle(),
        busy: () => runtime.busy(),
        nextTimer: () => runtime.nextTimer(),
        // Out of time with work left: stopped where a step ends, so no call runs twice.
        drain: () => runtime.drain(),
        async stop() {
          const ended = runtime.ended(sessionId);
          await runtime.dispose();
          // Stopped, with its state saved: what it took without keeping is consumed now.
          await store.flush(sessionId);
          log.debug("activation ended", { ended, sessionId });
          return { ended };
        },
      };
    },
    {
      ...(options.holdForTimerMs !== undefined && { holdForTimerMs: options.holdForTimerMs }),
    },
  );
}

/**
 * Until everything a restore started waits again, or for at most a few seconds: a restore
 * finishes some of its work after it resolves (a child it reopened claims its addresses).
 */
async function settledAfterRestore(runtime: InProcessRuntime, deadline: number): Promise<void> {
  await untilQuiescent(runtime, { pollMs: 10, until: Math.min(deadline, Date.now() + 5_000) });
}
