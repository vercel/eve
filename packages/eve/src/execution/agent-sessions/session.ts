import { normalizeAgentMessage } from "#execution/agent-sessions/message.js";
import type { MessageContent } from "#shared/message-content.js";
import type { RunHook } from "#execution/run-host.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import {
  forwardAgentSessionRequest,
  type AgentSessionRequest,
} from "#execution/agent-sessions/requests.js";
import type {
  AgentSessionMessage,
  AgentSessionReceipt,
  OpenedAgentSession,
} from "#execution/agent-sessions/start.js";
import type { RunUsageTally } from "#execution/agent-sessions/usage.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import { serializeOutputSchema } from "#tools/schema-emission.js";
import type {
  AgentMessageResult,
  AgentResponse,
  AgentSendOptions,
  AgentSession,
  AgentSessionOptions,
} from "#tools/workflow-definition.js";

type AgentTurnReply = AgentSessionRequest | RuntimeActionResultHookPayload;

type AgentTurnEnd =
  | { readonly kind: "ended"; readonly result: AgentMessageResult<unknown> }
  | { readonly kind: "failed"; readonly error: unknown };

export function createAgentSessions(
  run: WorkflowToolRunContext,
  usage: RunUsageTally,
): {
  readonly close: () => Promise<void>;
  readonly open: (name: string, options?: AgentSessionOptions) => AgentSession;
} {
  const sessions: OpenedAgentSession[] = [];
  const instances: RunAgentSession[] = [];
  let handles = 0;
  return {
    open: (name, options = {}) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new TypeError("ctx.agent() requires a non-empty agent name.");
      }
      const key = `${run.from.runId}:${String(handles)}`;
      handles += 1;
      const instance = new RunAgentSession({ key, name, options, run, sessions, usage });
      instances.push(instance);
      return instance;
    },
    close: async () => {
      await Promise.all(instances.map((instance) => instance.disposeHooks()));
      if (sessions.length === 0) return;
      await run.host.agentSessions.end({ sessions });
    },
  };
}

interface AwaitedReply {
  readonly ended: Promise<AgentTurnEnd>;
  readonly hook: RunHook<AgentTurnReply>;
  readonly reusable: boolean;
  readonly expectsData: boolean;
  readonly settle: (end: AgentTurnEnd) => void;
}

class RunAgentSession implements AgentSession {
  readonly #key: string;
  readonly #name: string;
  readonly #options: AgentSessionOptions;
  readonly #run: WorkflowToolRunContext;
  readonly #sessions: OpenedAgentSession[];
  readonly #usage: RunUsageTally;
  #opened: Promise<OpenedAgentSession> | undefined;
  #opener: WorkflowToolRunContext["from"] | undefined;
  readonly #awaited: AwaitedReply[] = [];
  #delivered: Promise<void> = Promise.resolve();
  #remote = false;
  #remoteReplyHooks: Promise<unknown> = Promise.resolve();
  #localHook: RunHook<AgentTurnReply> | undefined;
  #localIterator: AsyncIterator<AgentTurnReply> | undefined;
  readonly #disposableHooks = new Set<RunHook<AgentTurnReply>>();

  constructor(input: {
    readonly key: string;
    readonly name: string;
    readonly options: AgentSessionOptions;
    readonly run: WorkflowToolRunContext;
    readonly sessions: OpenedAgentSession[];
    readonly usage: RunUsageTally;
  }) {
    this.#key = input.key;
    this.#name = input.name;
    this.#options = input.options;
    this.#run = input.run;
    this.#sessions = input.sessions;
    this.#usage = input.usage;
  }

  async send<TOutput = unknown>(
    message: MessageContent<string | URL>,
    options: AgentSendOptions<TOutput> = {},
  ): Promise<AgentResponse<TOutput>> {
    message = normalizeAgentMessage(message);
    const outputSchema = normalizeRequestedOutputSchema(
      serializeOutputSchema(options.outputSchema),
    );
    const sender: AgentSessionSender = { context: this.#run.agentContext, from: this.#run.from };
    const auth = this.#run.auth;
    this.#remote ||= sender.context.remoteAgents?.includes(this.#name) ?? true;
    const reuseLocal = !this.#remote && this.#awaited.length === 0;
    const hook = this.#remote
      ? await this.#openRemoteReplyHook()
      : reuseLocal
        ? (this.#localHook ??= this.#run.host.createHook<AgentTurnReply>())
        : this.#run.host.createHook<AgentTurnReply>();
    const reply = this.#awaitReply(hook, outputSchema !== undefined, reuseLocal);
    const sending: AgentSessionMessage = { auth, message, outputSchema, replyTo: hook.token };
    const delivery = this.#delivered.then(() => this.#deliver(sending, sender));
    this.#delivered = delivery.catch(() => undefined);
    try {
      await delivery;
    } catch (error) {
      const index = this.#awaited.indexOf(reply);
      if (index >= 0) this.#awaited.splice(index, 1);
      if (reply.reusable) {
        if (this.#localHook === reply.hook) {
          this.#localHook = undefined;
          this.#localIterator = undefined;
        }
        await releaseHook(reply.hook);
      } else if (this.#disposableHooks.delete(reply.hook)) {
        await releaseHook(reply.hook);
      }
      throw error;
    }
    if (options.signal !== undefined) this.#cancelTurnOnAbort(reply, options.signal);
    const response: AgentResponse<unknown> = { result: () => reply.ended.then(unwrapTurnEnd) };
    return response as AgentResponse<TOutput>;
  }

  async disposeHooks(): Promise<void> {
    const hooks: RunHook<AgentTurnReply>[] = [...this.#disposableHooks];
    this.#disposableHooks.clear();
    if (this.#localHook !== undefined) {
      hooks.push(this.#localHook);
      this.#localHook = undefined;
      this.#localIterator = undefined;
    }
    await Promise.all(hooks.map(releaseHook));
  }

  #openRemoteReplyHook(): Promise<RunHook<AgentTurnReply>> {
    const opening = this.#remoteReplyHooks.then(() =>
      this.#run.host.createRemoteReplyHook<AgentTurnReply>(),
    );
    this.#remoteReplyHooks = opening.catch(() => undefined);
    return opening;
  }

  #awaitReply(
    hook: RunHook<AgentTurnReply>,
    expectsData: boolean,
    reusable: boolean,
  ): AwaitedReply {
    let settle: (end: AgentTurnEnd) => void = () => {};
    const ended = new Promise<AgentTurnEnd>((resolve) => {
      settle = resolve;
    });
    const reply: AwaitedReply = { ended, expectsData, hook, reusable, settle };
    this.#awaited.push(reply);
    if (reusable) {
      this.#localIterator ??= hook[Symbol.asyncIterator]();
      void this.#readLocalTurn(hook, this.#localIterator, expectsData).then((end) =>
        this.#settleThrough(reply, end),
      );
    } else {
      this.#disposableHooks.add(hook);
      void this.#readTurn(hook, expectsData).then((end) => this.#settleThrough(reply, end));
    }
    return reply;
  }

  #resetLocalHook(hook: RunHook<AgentTurnReply>): void {
    if (this.#localHook === hook) {
      this.#localHook = undefined;
      this.#localIterator = undefined;
    }
    void releaseHook(hook);
  }

  async #readLocalTurn(
    hook: RunHook<AgentTurnReply>,
    iterator: AsyncIterator<AgentTurnReply>,
    expectsData: boolean,
  ): Promise<AgentTurnEnd> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          this.#resetLocalHook(hook);
          return {
            error: new Error(`Agent "${this.#name}" stopped reporting before its turn ended.`),
            kind: "failed",
          };
        }
        const reply = next.value;
        if (reply.kind !== "runtime-action-result") {
          await this.#forwardRequest(hook.token, reply);
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
    } catch (error) {
      this.#resetLocalHook(hook);
      return { error, kind: "failed" };
    }
  }

  async #forwardRequest(replyTo: string, request: AgentSessionRequest): Promise<void> {
    await forwardAgentSessionRequest({
      from: this.#run.from,
      owner: this.#run.owner,
      replyTo,
      request,
      sessionKey: this.#key,
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
                    ...(address.earlierProtocol !== undefined && {
                      earlierProtocol: address.earlierProtocol,
                    }),
                    ...(address.dynamicBinding !== undefined && {
                      dynamicBinding: parseJsonValue(
                        JSON.parse(JSON.stringify(address.dynamicBinding)),
                      ),
                    }),
                  }
                : undefined,
            ),
    });
  }

  async #readTurn(hook: RunHook<AgentTurnReply>, expectsData: boolean): Promise<AgentTurnEnd> {
    try {
      for await (const reply of hook) {
        if (reply.kind !== "runtime-action-result") {
          await this.#forwardRequest(hook.token, reply);
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

  #settleThrough(reply: AwaitedReply, end: AgentTurnEnd): void {
    const index = this.#awaited.indexOf(reply);
    if (index < 0) return;
    for (const settled of this.#awaited.splice(0, index + 1)) {
      settled.settle(end);
      if (settled.reusable) {
        if (settled !== reply) this.#resetLocalHook(settled.hook);
      } else if (this.#disposableHooks.delete(settled.hook)) {
        void releaseHook(settled.hook);
      }
    }
  }

  async #deliver(message: AgentSessionMessage, sender: AgentSessionSender): Promise<void> {
    const { from } = sender;
    let receipt: AgentSessionReceipt;
    if (this.#opened === undefined) {
      const opening = this.#open(message, sender);
      this.#opened = opening.then(({ opened }) => opened);
      this.#opened.catch(() => undefined);
      ({ receipt } = await opening);
    } else {
      const opened = await this.#opened;
      receipt = await this.#run.host.agentSessions.send({ ...message, ...opened });
      if (receipt.sessionId !== opened.address.sessionId) {
        const redirected = {
          ...opened,
          address: { ...opened.address, sessionId: receipt.sessionId },
        };
        this.#sessions.push(redirected);
        this.#opened = Promise.resolve(redirected);
        await this.#run.owner.send({
          context: opened.context,
          from: this.#opener!,
          kind: "agent-started",
          session: redirected.address,
        });
      }
    }
    if (receipt.deliveryId === undefined) return;
    await this.#run.owner.send({
      deliveryId: receipt.deliveryId,
      from,
      kind: "agent-sent",
      sessionId: receipt.sessionId,
    });
  }

  async #open(
    message: AgentSessionMessage,
    { context, from }: AgentSessionSender,
  ): Promise<{ readonly opened: OpenedAgentSession; readonly receipt: AgentSessionReceipt }> {
    this.#opener = from;
    let opened: OpenedAgentSession | undefined;
    try {
      const { address, deliveryId } = await this.#run.host.agentSessions.open({
        ...message,
        context,
        key: this.#key,
        model: this.#options.model,
        name: this.#name,
        toolName: from.toolName,
      });
      opened = { address, context, key: this.#key };
      this.#sessions.push(opened);
      await this.#run.owner.send({ context, from, kind: "agent-started", session: address });
      return { opened, receipt: { deliveryId, sessionId: address.sessionId } };
    } catch (error) {
      this.#opened = undefined;
      this.#opener = undefined;
      if (opened !== undefined)
        await this.#run.host.agentSessions.stopLate(opened).catch(() => undefined);
      throw error;
    }
  }

  #cancelTurnOnAbort(reply: AwaitedReply, signal: AbortSignal): void {
    const cancel = (): void => {
      if (!this.#awaited.includes(reply) || this.#opened === undefined) return;
      void this.#opened
        .then((opened) => this.#run.host.agentSessions.cancelTurn(opened))
        .catch(() => {});
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  }
}

interface AgentSessionSender {
  readonly context: WorkflowToolRunContext["agentContext"];
  readonly from: WorkflowToolRunContext["from"];
}

async function releaseHook(hook: RunHook<AgentTurnReply>): Promise<void> {
  try {
    await hook.dispose();
  } catch {}
}

function unwrapTurnEnd(end: AgentTurnEnd): AgentMessageResult<unknown> {
  if (end.kind === "failed") throw end.error;
  return end.result;
}

const NO_REPLY = { data: undefined, reply: undefined } as const;

function failedTurn(error: unknown, sessionEnded = false): AgentMessageResult<unknown> {
  return { ...NO_REPLY, sessionEnded, error: { message: toErrorMessage(error) }, status: "failed" };
}

function toAgentMessageResult(
  result: RuntimeSubagentResult,
  expectsData: boolean,
): AgentMessageResult<unknown> {
  if (result.origin !== "child") return failedTurn(result.output);
  const { outcome } = result;
  switch (outcome.result.kind) {
    case "failed":
      return failedTurn(outcome.result.error, outcome.kind === "terminal");
    case "cancelled":
      return { ...NO_REPLY, sessionEnded: outcome.kind === "terminal", status: "cancelled" };
    case "succeeded": {
      const { output } = outcome.result;
      const common = { status: "completed" as const, sessionEnded: outcome.kind === "terminal" };
      if (expectsData) return { data: output, reply: undefined, ...common };
      return { data: undefined, reply: typeof output === "string" ? output : undefined, ...common };
    }
  }
}
