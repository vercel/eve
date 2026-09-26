import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  forwardAgentSessionRequest,
  type AgentSessionRequest,
} from "#execution/agent-sessions/requests.js";
import {
  cancelAgentSessionTurnStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  type AgentSessionAddress,
  type AgentSessionMessage,
} from "#execution/agent-sessions/steps.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type {
  StartedAgentSession,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import { serializeOutputSchema } from "#tools/schema-emission.js";
import type {
  AgentMessageResult,
  AgentResponse,
  AgentSendOptions,
  AgentSession,
} from "#tools/workflow-definition.js";

/** What a run's sessions need from the run that owns them. */
export interface AgentSessionOwner {
  readonly context: AgentSessionContext;
  readonly from: WorkflowToolRunRef;
  /** The run's inbox, which relays questions and `agent.started` to its session. */
  readonly inbox: string;
}

type AgentTurnReply = AgentSessionRequest | RuntimeActionResultHookPayload;

type AgentTurnEnd =
  | { readonly kind: "ended"; readonly result: AgentMessageResult<unknown> }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * The sessions one workflow run opens with `ctx.agent`. A handle's position in
 * the run names it, so replay reaches the same session, and every session the
 * run opened ends when the run finishes.
 */
export class AgentSessions {
  readonly #owner: AgentSessionOwner;
  readonly #opened: AgentSessionAddress[] = [];
  #handles = 0;
  #announcements = 0;

  constructor(owner: AgentSessionOwner) {
    this.#owner = owner;
  }

  /** `agent.started` messages sent to the run's inbox, which the run relays before its outcome. */
  get announcements(): number {
    return this.#announcements;
  }

  open(name: string): AgentSession {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("ctx.agent() requires a non-empty agent name.");
    }
    const key = `${this.#owner.from.runId}:${String(this.#handles)}`;
    this.#handles += 1;
    return new RunAgentSession({ key, name, owner: this.#owner, sessions: this });
  }

  /** Ends every session the run opened, cancelling any turn still running. */
  async end(): Promise<void> {
    if (this.#opened.length === 0) return;
    await endAgentSessionsStep({ context: this.#owner.context, sessions: this.#opened });
  }

  /** Records an opened session and has the run's session publish `agent.started`. */
  async started(address: AgentSessionAddress): Promise<void> {
    this.#opened.push(address);
    await resumeHookStep(this.#owner.inbox, {
      from: this.#owner.from,
      kind: "agent-started",
      session: toStartedAgentSession(address),
    });
    this.#announcements += 1;
  }
}

/** One turn of a session: its result and questions arrive on the turn's own hook. */
interface AgentTurn {
  readonly hook: Hook<AgentTurnReply>;
  readonly response: AgentResponse<unknown>;
}

class RunAgentSession implements AgentSession {
  readonly #key: string;
  readonly #name: string;
  readonly #owner: AgentSessionOwner;
  readonly #sessions: AgentSessions;
  #address: Promise<AgentSessionAddress> | undefined;
  #turn: AgentTurn | undefined;

  constructor(input: {
    readonly key: string;
    readonly name: string;
    readonly owner: AgentSessionOwner;
    readonly sessions: AgentSessions;
  }) {
    this.#key = input.key;
    this.#name = input.name;
    this.#owner = input.owner;
    this.#sessions = input.sessions;
  }

  async send<TOutput = unknown>(
    message: string,
    options: AgentSendOptions<TOutput> = {},
  ): Promise<AgentResponse<TOutput>> {
    if (typeof message !== "string" || message.trim() === "") {
      throw new TypeError(`ctx.agent("${this.#name}").send() requires a non-empty message.`);
    }
    const outputSchema = serializeOutputSchema(options.outputSchema);
    const running = this.#turn;
    const turn = running ?? this.#startTurn(outputSchema !== undefined);
    try {
      await this.#deliver({
        context: this.#owner.context,
        message,
        outputSchema,
        replyTo: turn.hook.token,
      });
    } catch (error) {
      if (running === undefined) await this.#closeTurn(turn);
      throw error;
    }
    if (options.signal !== undefined) this.#cancelTurnOnAbort(turn, options.signal);
    return turn.response as AgentResponse<TOutput>;
  }

  #startTurn(expectsData: boolean): AgentTurn {
    const hook = createHook<AgentTurnReply>();
    const ended = this.#readTurn(hook, expectsData);
    const turn: AgentTurn = {
      hook,
      response: { result: () => ended.then(unwrapTurnEnd) },
    };
    this.#turn = turn;
    return turn;
  }

  /** Forwards the turn's questions up to the session and settles with its result. */
  async #readTurn(hook: Hook<AgentTurnReply>, expectsData: boolean): Promise<AgentTurnEnd> {
    try {
      for await (const reply of hook) {
        if (reply.kind !== "runtime-action-result") {
          await forwardAgentSessionRequest({
            from: this.#owner.from,
            inbox: this.#owner.inbox,
            replyTo: hook.token,
            request: reply,
          });
          continue;
        }
        const result = reply.results.find(
          (candidate): candidate is RuntimeSubagentResult => candidate.kind === "subagent-result",
        );
        if (result !== undefined) {
          return { kind: "ended", result: toAgentMessageResult(result, expectsData) };
        }
      }
      return {
        error: new Error(`Agent "${this.#name}" stopped reporting before its turn ended.`),
        kind: "failed",
      };
    } catch (error) {
      return { error, kind: "failed" };
    } finally {
      await this.#closeTurn({ hook });
    }
  }

  async #closeTurn(turn: Pick<AgentTurn, "hook">): Promise<void> {
    if (this.#turn?.hook === turn.hook) this.#turn = undefined;
    try {
      await disposeHook(turn.hook);
    } catch {
      // The turn already has its outcome; releasing its hook is best effort.
    }
  }

  async #deliver(message: AgentSessionMessage): Promise<void> {
    if (this.#address === undefined) {
      this.#address = this.#open(message);
      await this.#address;
      return;
    }
    const address = await this.#address;
    await sendAgentSessionMessageStep({ ...message, address });
  }

  async #open(message: AgentSessionMessage): Promise<AgentSessionAddress> {
    try {
      const address = await openAgentSessionStep({ ...message, key: this.#key, name: this.#name });
      await this.#sessions.started(address);
      return address;
    } catch (error) {
      this.#address = undefined;
      throw error;
    }
  }

  /** Aborting cancels only the turn the message went to, never a later one. */
  #cancelTurnOnAbort(turn: AgentTurn, signal: AbortSignal): void {
    const cancel = (): void => {
      if (this.#turn !== turn || this.#address === undefined) return;
      void this.#address
        .then((address) => cancelAgentSessionTurnStep({ address, context: this.#owner.context }))
        .catch(() => {});
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  }
}

function unwrapTurnEnd(end: AgentTurnEnd): AgentMessageResult<unknown> {
  if (end.kind === "failed") throw end.error;
  return end.result;
}

const NO_REPLY = { data: undefined, message: undefined } as const;

function toAgentMessageResult(
  result: RuntimeSubagentResult,
  expectsData: boolean,
): AgentMessageResult<unknown> {
  if (result.origin !== "child") return { ...NO_REPLY, status: "failed" };
  const { outcome } = result;
  switch (outcome.result.kind) {
    case "failed":
      return { ...NO_REPLY, status: "failed" };
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

function toStartedAgentSession(address: AgentSessionAddress): StartedAgentSession {
  if (address.kind === "local") {
    return { name: address.name, sessionId: address.sessionId };
  }
  const remote: { resolverId?: string; url: string } = { url: address.url };
  if (address.resolverId !== undefined) remote.resolverId = address.resolverId;
  return { name: address.name, remote, sessionId: address.sessionId };
}
