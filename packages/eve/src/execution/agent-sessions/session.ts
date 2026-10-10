import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import {
  forwardAgentSessionRequest,
  type AgentSessionRequest,
} from "#execution/agent-sessions/requests.js";
import {
  cancelAgentSessionTurnStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  type AgentSessionMessage,
  type OpenedAgentSession,
} from "#execution/agent-sessions/steps.js";
import type { RunUsageTally } from "#execution/agent-sessions/usage.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import { toErrorMessage } from "#shared/errors.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import { serializeOutputSchema } from "#tools/schema-emission.js";
import type {
  AgentMessageResult,
  AgentResponse,
  AgentSendOptions,
  AgentSession,
} from "#tools/workflow-definition.js";

type AgentTurnReply = AgentSessionRequest | RuntimeActionResultHookPayload;

type AgentTurnEnd =
  | { readonly kind: "ended"; readonly result: AgentMessageResult<unknown> }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Opens `ctx.agent` sessions for a workflow run. A handle's position in the
 * run names its session, so replay reaches the same one, and `close` ends
 * every session the run opened, cancelling any turn still running.
 */
export function createAgentSessions(
  run: WorkflowToolRunContext,
  usage: RunUsageTally,
): {
  readonly close: () => Promise<void>;
  readonly open: (name: string) => AgentSession;
} {
  const sessions: OpenedAgentSession[] = [];
  let handles = 0;
  return {
    open: (name) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new TypeError("ctx.agent() requires a non-empty agent name.");
      }
      const key = `${run.from.runId}:${String(handles)}`;
      handles += 1;
      return new RunAgentSession({ key, name, run, sessions, usage });
    },
    close: async () => {
      if (sessions.length === 0) return;
      await endAgentSessionsStep({ sessions });
    },
  };
}

/**
 * A sent message awaiting its reply. The reply, and the questions asked while
 * the agent works on the message, arrive on the message's own hook.
 */
interface AwaitedReply {
  readonly ended: Promise<AgentTurnEnd>;
  readonly hook: Hook<AgentTurnReply>;
  readonly settle: (end: AgentTurnEnd) => void;
}

class RunAgentSession implements AgentSession {
  readonly #key: string;
  readonly #name: string;
  readonly #run: WorkflowToolRunContext;
  /** Every session the run opened, which it ends when it finishes. */
  readonly #sessions: OpenedAgentSession[];
  /** What the run's sessions spent, which the run reports to its calling session. */
  readonly #usage: RunUsageTally;
  #opened: Promise<OpenedAgentSession> | undefined;
  /** Oldest first. */
  readonly #awaited: AwaitedReply[] = [];

  constructor(input: {
    readonly key: string;
    readonly name: string;
    readonly run: WorkflowToolRunContext;
    readonly sessions: OpenedAgentSession[];
    readonly usage: RunUsageTally;
  }) {
    this.#key = input.key;
    this.#name = input.name;
    this.#run = input.run;
    this.#sessions = input.sessions;
    this.#usage = input.usage;
  }

  async send<TOutput = unknown>(
    message: string,
    options: AgentSendOptions<TOutput> = {},
  ): Promise<AgentResponse<TOutput>> {
    if (typeof message !== "string" || message.trim() === "") {
      throw new TypeError(`ctx.agent("${this.#name}").send() requires a non-empty message.`);
    }
    // The reply's shape and the child's output mode must agree on whether a
    // schema was requested, and an empty one requests none.
    const outputSchema = normalizeRequestedOutputSchema(
      serializeOutputSchema(options.outputSchema),
    );
    const reply = this.#awaitReply(outputSchema !== undefined);
    try {
      await this.#deliver({
        auth: this.#run.auth,
        message,
        outputSchema,
        replyTo: reply.hook.token,
      });
    } catch (error) {
      this.#awaited.splice(this.#awaited.indexOf(reply), 1);
      await releaseHook(reply.hook);
      throw error;
    }
    if (options.signal !== undefined) this.#cancelTurnOnAbort(reply, options.signal);
    const response: AgentResponse<unknown> = { result: () => reply.ended.then(unwrapTurnEnd) };
    return response as AgentResponse<TOutput>;
  }

  #awaitReply(expectsData: boolean): AwaitedReply {
    const hook = createHook<AgentTurnReply>();
    let settle: (end: AgentTurnEnd) => void = () => {};
    const ended = new Promise<AgentTurnEnd>((resolve) => {
      settle = resolve;
    });
    const reply: AwaitedReply = { ended, hook, settle };
    this.#awaited.push(reply);
    void this.#readTurn(hook, expectsData).then((end) => this.#settleThrough(reply, end));
    return reply;
  }

  /**
   * Forwards the turn's questions up to the session and returns its end. The
   * turn's usage is tallied before its end settles any reply, so the reply the
   * body sends with the turn's result carries it.
   */
  async #readTurn(hook: Hook<AgentTurnReply>, expectsData: boolean): Promise<AgentTurnEnd> {
    try {
      for await (const reply of hook) {
        if (reply.kind !== "runtime-action-result") {
          await forwardAgentSessionRequest({
            from: this.#run.from,
            owner: this.#run.owner,
            replyTo: hook.token,
            request: reply,
            remote:
              this.#opened === undefined
                ? undefined
                : await this.#opened.then(({ address }) =>
                    address.kind === "remote"
                      ? {
                          forwardPrincipal: address.forwardPrincipal,
                          name: address.name,
                          resolverId: address.resolverId,
                          url: address.url,
                          sessionId: address.sessionId,
                        }
                      : undefined,
                  ),
          });
          continue;
        }
        const result = reply.results.find(
          (candidate): candidate is RuntimeSubagentResult => candidate.kind === "subagent-result",
        );
        if (result !== undefined) {
          if (result.origin === "child") this.#usage.record(result.outcome.usageDelta);
          return { kind: "ended", result: toAgentMessageResult(result, expectsData) };
        }
      }
      return {
        error: new Error(`Agent "${this.#name}" stopped reporting before its turn ended.`),
        kind: "failed",
      };
    } catch (error) {
      return { error, kind: "failed" };
    }
  }

  /**
   * A turn reports to the latest message it read, and the messages sent before
   * it that still await a reply joined the same turn, so its end settles them
   * all. A message the agent reads only after its turn ended starts the next
   * turn and gets that turn's reply.
   */
  async #settleThrough(reply: AwaitedReply, end: AgentTurnEnd): Promise<void> {
    const index = this.#awaited.indexOf(reply);
    if (index < 0) return;
    for (const settled of this.#awaited.splice(0, index + 1)) {
      settled.settle(end);
      await releaseHook(settled.hook);
    }
  }

  async #deliver(message: AgentSessionMessage): Promise<void> {
    if (this.#opened === undefined) {
      this.#opened = this.#open(message);
      await this.#opened;
      return;
    }
    const opened = await this.#opened;
    await sendAgentSessionMessageStep({ ...message, ...opened });
  }

  /**
   * Opens the session as a child of the call the run serves now. Its lineage
   * and trace come from that call, and its later messages keep them even when
   * the run serves another call by then; each message carries its own auth.
   */
  async #open(message: AgentSessionMessage): Promise<OpenedAgentSession> {
    const { agentContext: context, from } = this.#run;
    try {
      const address = await openAgentSessionStep({
        ...message,
        context,
        key: this.#key,
        name: this.#name,
      });
      const opened = { address, context, key: this.#key };
      this.#sessions.push(opened);
      await this.#run.owner.send({ from, kind: "agent-started", session: address });
      return opened;
    } catch (error) {
      this.#opened = undefined;
      throw error;
    }
  }

  /** Aborting cancels only the turn the message went to, never a later one. */
  #cancelTurnOnAbort(reply: AwaitedReply, signal: AbortSignal): void {
    const cancel = (): void => {
      if (!this.#awaited.includes(reply) || this.#opened === undefined) return;
      void this.#opened.then((opened) => cancelAgentSessionTurnStep(opened)).catch(() => {});
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  }
}

async function releaseHook(hook: Hook<AgentTurnReply>): Promise<void> {
  try {
    await disposeHook(hook);
  } catch {
    // The reply already has its outcome; releasing its hook is best effort.
  }
}

function unwrapTurnEnd(end: AgentTurnEnd): AgentMessageResult<unknown> {
  if (end.kind === "failed") throw end.error;
  return end.result;
}

const NO_REPLY = { data: undefined, message: undefined } as const;

function failedTurn(error: unknown): AgentMessageResult<unknown> {
  return { ...NO_REPLY, error: { message: toErrorMessage(error) }, status: "failed" };
}

function toAgentMessageResult(
  result: RuntimeSubagentResult,
  expectsData: boolean,
): AgentMessageResult<unknown> {
  if (result.origin !== "child") return failedTurn(result.output);
  const { outcome } = result;
  switch (outcome.result.kind) {
    case "failed":
      return failedTurn(outcome.result.error);
    case "cancelled":
      return { ...NO_REPLY, status: "waiting" };
    case "succeeded": {
      const { output } = outcome.result;
      const status = outcome.kind === "terminal" ? "completed" : "waiting";
      if (expectsData) return { data: output, message: undefined, status };
      return { data: undefined, message: typeof output === "string" ? output : undefined, status };
    }
  }
}
