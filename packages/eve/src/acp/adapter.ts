import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import {
  PROTOCOL_VERSION,
  RequestError,
  methods,
  type AgentContext,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
  type ToolCall,
} from "#compiled/@agentclientprotocol/sdk/index.js";
import { Client, ClientError } from "#client/index.js";
import type { ClientOptions, SendTurnInput, SessionState } from "#client/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";

const ANSWER_FIELD = "answer";
const ERROR_CODE_BUSY = -32_001;
const ERROR_CODE_EVE = -32_002;
const ERROR_CODE_UNSUPPORTED = -32_003;

interface ActivePrompt {
  cancelRequested: boolean;
  readonly outboundController: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  turnId?: string;
}

interface AdapterClientSession {
  readonly state: SessionState;
  send(input: SendTurnInput): Promise<AsyncIterable<HandleMessageStreamEvent>>;
  cancel(options?: { turnId?: string }): Promise<unknown>;
  reset(): Promise<unknown>;
}

interface AdapterClient {
  session(): AdapterClientSession;
}

interface AcpSession {
  readonly client: AdapterClientSession;
  active?: ActivePrompt;
  readonly tools: Map<string, ToolCall>;
}

/** Configuration for translating one ACP client connection to an eve server. */
export interface EveAcpAdapterOptions {
  readonly eveVersion: string;
  readonly auth?: ClientOptions["auth"];
  readonly headers?: ClientOptions["headers"];
  readonly serverUrl: string;
  /** Local workspace root to enforce; omit when connecting to a remote deployment. */
  readonly workspaceRoot?: string;
  /** @internal Test seam for the public eve client boundary. */
  readonly client?: AdapterClient;
}

/**
 * Translates stable ACP v1 sessions onto the public eve HTTP client.
 *
 * The adapter owns only process-local ACP identities. Conversation durability,
 * event cursors, cancellation, and reset behavior remain owned by
 * {@link ClientSession}.
 */
export class EveAcpAdapter {
  readonly #client: AdapterClient;
  readonly #eveVersion: string;
  readonly #workspaceRoot: string | undefined;
  #formElicitationSupported = false;
  readonly #sessions = new Map<string, AcpSession>();

  constructor(options: EveAcpAdapterOptions) {
    this.#eveVersion = options.eveVersion;
    this.#workspaceRoot = options.workspaceRoot;
    this.#client =
      options.client ??
      new Client({
        auth: options.auth,
        headers: options.headers,
        host: options.serverUrl,
        preserveCompletedSessions: true,
        redirect: "manual",
      });
  }

  initialize(params: InitializeRequest): InitializeResponse {
    this.#formElicitationSupported = params.clientCapabilities?.elicitation?.form !== undefined;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      agentInfo: {
        name: "eve",
        title: "eve",
        version: this.#eveVersion,
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers.length > 0) {
      throw unsupported("Client-provided MCP servers are not supported by eve ACP mode.");
    }
    if ((params.additionalDirectories?.length ?? 0) > 0) {
      throw unsupported("Additional workspace directories are not supported by eve ACP mode.");
    }

    if (this.#workspaceRoot !== undefined) {
      const requestedRoot = await normalizedRealpath(params.cwd, "session/new.cwd");
      const workspaceRoot = await normalizedRealpath(
        this.#workspaceRoot,
        "the eve application root",
      );
      if (requestedRoot !== workspaceRoot) {
        throw RequestError.invalidParams(
          { cwd: params.cwd, workspaceRoot },
          "ACP cwd must be the eve application root",
        );
      }
    }

    const sessionId = randomUUID();
    this.#sessions.set(sessionId, {
      client: this.#client.session(),
      tools: new Map(),
    });
    return { sessionId };
  }

  async prompt(
    params: PromptRequest,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const session = this.#getSession(params.sessionId);
    if (session.active !== undefined) {
      throw new RequestError(
        ERROR_CODE_BUSY,
        `ACP session ${params.sessionId} already has an active prompt.`,
      );
    }

    const message = promptContent(params);
    const settled = Promise.withResolvers<void>();
    const active: ActivePrompt = {
      cancelRequested: false,
      outboundController: new AbortController(),
      settled: settled.promise,
      resolveSettled: settled.resolve,
    };
    session.active = active;
    const onProtocolCancel = () => {
      void this.#cancelActive(session).catch(() => undefined);
    };
    if (signal.aborted) {
      onProtocolCancel();
    } else {
      signal.addEventListener("abort", onProtocolCancel, { once: true });
    }

    // A protocol cancel — this request's own signal — is an error for the
    // caller, while a client-side cancel (declining an input request) is a
    // normal stop reason. Both can arrive at any await in the loop below.
    const clientCancelled = (): boolean => {
      if (signal.aborted) throw RequestError.requestCancelled({ sessionId: params.sessionId });
      return active.cancelRequested;
    };

    try {
      if (clientCancelled()) return { stopReason: "cancelled" };
      let input: SendTurnInput = { message };
      for (;;) {
        const response = await session.client.send(input);
        if (active.cancelRequested || signal.aborted) {
          await this.#cancelActive(session);
        }

        const inputRequests: InputRequest[] = [];
        let cancelled = false;
        let failure:
          | Extract<HandleMessageStreamEvent, { type: "turn.failed" | "session.failed" }>
          | undefined;
        let unsupportedEvent: RequestError | undefined;

        for await (const event of response) {
          const turnId = "data" in event && "turnId" in event.data ? event.data.turnId : undefined;
          if (typeof turnId === "string") active.turnId = turnId;

          if (event.type === "input.requested") inputRequests.push(...event.data.requests);
          if (event.type === "authorization.required") {
            unsupportedEvent = unsupported(
              "Connection authorization cannot be completed through eve ACP mode.",
            );
          }
          if (event.type === "turn.cancelled") cancelled = true;
          if (event.type === "turn.failed" || event.type === "session.failed") failure = event;
          await this.#projectEvent(params.sessionId, session, event, client);
        }

        if (clientCancelled() || cancelled) return { stopReason: "cancelled" };
        if (failure !== undefined) throw eveFailure(failure);
        if (unsupportedEvent !== undefined) throw unsupportedEvent;
        if (inputRequests.length === 0) return { stopReason: "end_turn" };

        let inputResponses: InputResponse[];
        try {
          inputResponses = await Promise.all(
            inputRequests.map((request) =>
              this.#requestInput(params.sessionId, session, request, client, signal),
            ),
          );
        } catch (error) {
          if (clientCancelled()) return { stopReason: "cancelled" };
          throw error;
        }
        if (clientCancelled()) return { stopReason: "cancelled" };
        input = { inputResponses };
      }
    } catch (error) {
      throw acpRequestError(error);
    } finally {
      signal.removeEventListener("abort", onProtocolCancel);
      session.tools.clear();
      active.resolveSettled();
      if (session.active === active) session.active = undefined;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.active === undefined) return;
    session.active.cancelRequested = true;
    await this.#cancelActive(session);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#getSession(sessionId);
    this.#sessions.delete(sessionId);
    await this.#retireSession(session);
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.#retireSession(session)));
  }

  async #retireSession(session: AcpSession): Promise<void> {
    let cancellationError: unknown;
    if (session.active !== undefined) {
      const active = session.active;
      active.cancelRequested = true;
      try {
        await this.#cancelActive(session);
      } catch (error) {
        cancellationError = error;
      }
      await active.settled;
    }

    try {
      await session.client.reset();
    } catch (resetError) {
      if (cancellationError !== undefined) {
        throw new AggregateError(
          [cancellationError, resetError],
          "Could not cancel or reset the eve session",
        );
      }
      throw resetError;
    }
    if (cancellationError !== undefined) throw cancellationError;
  }

  async #cancelActive(session: AcpSession): Promise<void> {
    session.active?.outboundController.abort();
    if (session.client.state.sessionId === undefined) return;
    await session.client.cancel(
      session.active?.turnId === undefined ? undefined : { turnId: session.active.turnId },
    );
  }

  #getSession(sessionId: string): AcpSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw RequestError.invalidParams({ sessionId }, "Unknown or closed ACP session");
    }
    return session;
  }

  async #projectEvent(
    sessionId: string,
    session: AcpSession,
    event: HandleMessageStreamEvent,
    client: AgentContext,
  ): Promise<void> {
    switch (event.type) {
      case "message.appended":
        await notifyUpdate(client, sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.data.messageDelta },
          messageId: `${event.data.turnId}:message:${event.data.stepIndex}`,
        });
        return;
      case "reasoning.appended":
        await notifyUpdate(client, sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.data.reasoningDelta },
          messageId: `${event.data.turnId}:thought:${event.data.stepIndex}`,
        });
        return;
      case "actions.requested":
        for (const action of event.data.actions) {
          const toolCall = toolCallForAction(action);
          session.tools.set(action.callId, toolCall);
          await notifyUpdate(client, sessionId, { sessionUpdate: "tool_call", ...toolCall });
        }
        return;
      case "action.result": {
        const result = event.data.result;
        const status = event.data.status !== "completed" || result.isError ? "failed" : "completed";
        await notifyUpdate(client, sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: result.callId,
          status,
          content: [
            { type: "content", content: { type: "text", text: stringifyOutput(result.output) } },
          ],
          rawOutput: result.output,
        });
        return;
      }
      default:
        return;
    }
  }

  async #requestInput(
    sessionId: string,
    session: AcpSession,
    request: InputRequest,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<InputResponse> {
    const cancellationSignal = AbortSignal.any([signal, session.active!.outboundController.signal]);
    if (request.display === "confirmation") {
      const approveId = `${request.requestId}:approve`;
      const denyId = `${request.requestId}:deny`;
      const toolCall =
        session.tools.get(request.action.callId) ?? toolCallForAction(request.action);
      const response = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall,
          options: [
            { kind: "allow_once", name: "Approve", optionId: approveId },
            { kind: "reject_once", name: "Deny", optionId: denyId },
          ],
        },
        { cancellationSignal },
      );
      if (response.outcome.outcome === "cancelled") {
        return this.#declineInput(session, request);
      }
      if (response.outcome.optionId === approveId) {
        return { requestId: request.requestId, optionId: "approve" };
      }
      if (response.outcome.optionId === denyId) {
        return { requestId: request.requestId, optionId: "deny" };
      }
      throw RequestError.invalidParams(
        { optionId: response.outcome.optionId },
        "Unknown ACP permission option",
      );
    }

    if (!this.#formElicitationSupported) {
      throw unsupported(
        "The ACP client does not support form elicitation required by this eve question.",
      );
    }

    const property = elicitationProperty(request);
    const response = await client.request(
      methods.client.elicitation.create,
      {
        mode: "form",
        sessionId,
        message: request.prompt,
        requestedSchema: {
          type: "object",
          properties: { [ANSWER_FIELD]: property },
          required: [ANSWER_FIELD],
        },
      },
      { cancellationSignal },
    );
    if (response.action !== "accept") {
      return this.#declineInput(session, request);
    }
    const content = response.content as Record<string, unknown> | null | undefined;
    const answer = content?.[ANSWER_FIELD];
    if (typeof answer !== "string") {
      throw RequestError.invalidParams(
        response.content,
        "ACP elicitation response must contain a string answer",
      );
    }
    if (request.display === "select") {
      if (!request.options?.some((option) => option.id === answer)) {
        throw RequestError.invalidParams({ answer }, "Unknown eve question option");
      }
      return { requestId: request.requestId, optionId: answer };
    }
    return { requestId: request.requestId, text: answer };
  }

  /**
   * The client dismissed a request instead of answering it. eve receives an
   * empty response so the turn can wind down, and the prompt settles as
   * cancelled rather than as a failure.
   */
  #declineInput(session: AcpSession, request: InputRequest): InputResponse {
    this.#cancelClientInput(session);
    return { requestId: request.requestId };
  }

  #cancelClientInput(session: AcpSession): void {
    const active = session.active!;
    active.cancelRequested = true;
    active.outboundController.abort();
  }
}

async function normalizedRealpath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw RequestError.invalidParams(
      { path },
      `Could not resolve ${label}: ${errorMessage(error)}`,
    );
  }
}

function promptContent(params: PromptRequest): Array<{ type: "text"; text: string }> {
  const content = params.prompt.map((part) => {
    if (part.type !== "text") {
      throw unsupported(`ACP prompt content type ${JSON.stringify(part.type)} is not supported.`);
    }
    return { type: "text" as const, text: part.text };
  });
  if (content.every((part) => part.text.length === 0)) {
    throw RequestError.invalidParams(
      params.prompt,
      "ACP prompt must contain at least one non-empty text block",
    );
  }
  return content;
}

function toolCallForAction(action: RuntimeActionRequest): ToolCall {
  const title =
    action.kind === "tool-call"
      ? action.toolName
      : action.kind === "load-skill"
        ? "Load skill"
        : action.name;
  return {
    toolCallId: action.callId,
    title,
    kind: "other",
    status: "pending",
    rawInput: action.input,
  };
}

function elicitationProperty(request: InputRequest) {
  if (request.display === "select" && request.allowFreeform !== true && request.options?.length) {
    return {
      type: "string" as const,
      title: request.prompt,
      oneOf: request.options.map((option) => ({
        const: option.id,
        title: option.label,
        description: option.description,
      })),
    };
  }
  if (request.display === "text" && request.allowFreeform !== false) {
    return { type: "string" as const, title: request.prompt, minLength: 1 };
  }
  throw unsupported("This eve question shape cannot be represented by ACP form elicitation.");
}

async function notifyUpdate(
  client: AgentContext,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await client.notify(methods.client.session.update, { sessionId, update });
}

function stringifyOutput(output: RuntimeActionResult["output"]): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function unsupported(message: string): RequestError {
  return new RequestError(ERROR_CODE_UNSUPPORTED, message);
}

function eveFailure(
  event: Extract<HandleMessageStreamEvent, { type: "turn.failed" | "session.failed" }>,
): RequestError {
  return new RequestError(ERROR_CODE_EVE, event.data.message, {
    code: event.data.code,
    details: event.data.details,
  });
}

function acpRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof ClientError) {
    return new RequestError(ERROR_CODE_EVE, error.message, { httpStatus: error.status });
  }
  return new RequestError(ERROR_CODE_EVE, errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
