const SESSION_API_PATH = "/eve/v1/session";
const SESSION_STREAM_ROUTE_PREFIX = "/eve/v1/session";
const INFO_API_PATH = "/eve/v1/info";

function createSessionContinuePath(sessionId: string): string {
  return `${SESSION_API_PATH}/${encodeURIComponent(sessionId)}`;
}

const EVE_SESSION_ID_HEADER = "x-eve-session-id";
const MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const DEFAULT_SESSION_TURN_TIMEOUT_MS = 60_000;

export interface SendMessageInput {
  readonly continuationToken?: string;
  readonly message: string;
  readonly sessionId?: string;
}

export interface SentMessageResult {
  readonly continuationToken?: string;
  readonly sessionId?: string;
}

export interface AgentInfoSource {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId?: string;
  readonly sourceKind: string;
}

export interface AgentInfoToolEntry extends AgentInfoSource {
  readonly description: string;
  readonly hasAuth: boolean;
  readonly hasExecute: boolean;
  readonly hasModelOutputProjection: boolean;
  readonly hasOutputSchema: boolean;
  readonly inputSchema: unknown;
  readonly name: string;
  readonly origin: "authored" | "framework";
  readonly outputSchema: unknown;
  readonly replacesFrameworkTool: boolean;
  readonly requiresApproval: boolean;
}

export interface AgentInfoFrameworkToolEntry extends AgentInfoToolEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredTool: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoDynamicResolverEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly origin: "authored" | "framework";
  readonly slug: string;
}

export interface AgentInfoSkillEntry extends AgentInfoSource {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name: string;
}

export interface AgentInfoInstructionsEntry extends AgentInfoSource {
  readonly markdown: string;
  readonly name: string;
}

export interface AgentInfoScheduleEntry extends AgentInfoSource {
  readonly cron: string;
  readonly hasRun: boolean;
  readonly markdown?: string;
  readonly name: string;
}

export interface AgentInfoSubagentEntry extends AgentInfoSource {
  readonly description: string;
  readonly entryPath: string;
  readonly name: string;
  readonly nodeId: string;
  readonly rootPath: string;
  readonly summary: {
    readonly channels: number;
    readonly connections: number;
    readonly hooks: number;
    readonly instructions: boolean;
    readonly schedules: number;
    readonly skills: number;
    readonly tools: number;
  };
}

export interface AgentInfoChannelEntry extends AgentInfoSource {
  readonly adapterKind?: string;
  readonly method: string;
  readonly name: string;
  readonly origin: "authored" | "framework";
  readonly urlPath: string;
}

export interface AgentInfoFrameworkChannelEntry extends AgentInfoChannelEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredChannel: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoConnectionEntry extends AgentInfoSource {
  readonly connectionName: string;
  readonly description: string;
  readonly hasApproval: boolean;
  readonly hasAuthorization: boolean;
  readonly hasHeaders: boolean;
  readonly protocol: string;
  readonly toolFilter?: unknown;
  readonly url: string;
}

export interface AgentInfoHookEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly slug: string;
}

export interface AgentInfoSandboxEntry extends AgentInfoSource {
  readonly backendKind?: string;
  readonly description?: string;
  readonly hasBootstrap: boolean;
  readonly hasOnSession: boolean;
  readonly revalidationKey?: string;
  readonly sourceHash?: string;
}

export interface AgentInformation {
  readonly agent: {
    readonly agentRoot: string;
    readonly appRoot: string;
    readonly configSource?: AgentInfoSource;
    readonly description?: string;
    readonly model: {
      readonly contextWindowTokens?: number;
      readonly id: string;
      readonly providerOptions?: unknown;
      readonly source?: AgentInfoSource;
    };
    readonly name: string;
    readonly outputSchema?: unknown;
  };
  readonly channels: {
    readonly authored: readonly AgentInfoChannelEntry[];
    readonly available: readonly AgentInfoChannelEntry[];
    readonly disabledFramework: readonly string[];
    readonly framework: readonly AgentInfoFrameworkChannelEntry[];
  };
  readonly connections: readonly AgentInfoConnectionEntry[];
  readonly diagnostics: {
    readonly discoveryErrors: number;
    readonly discoveryWarnings: number;
  };
  readonly hooks: readonly AgentInfoHookEntry[];
  readonly instructions: {
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
    readonly static: AgentInfoInstructionsEntry | null;
  };
  readonly kind: "eve-agent-info";
  readonly mode: "development" | "production";
  readonly sandbox: AgentInfoSandboxEntry | null;
  readonly schedules: readonly AgentInfoScheduleEntry[];
  readonly skills: {
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
    readonly static: readonly AgentInfoSkillEntry[];
  };
  readonly subagents: {
    readonly local: readonly AgentInfoSubagentEntry[];
    readonly total: number;
  };
  readonly tools: {
    readonly authored: readonly AgentInfoToolEntry[];
    readonly available: readonly AgentInfoToolEntry[];
    readonly disabledFramework: readonly string[];
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
    readonly framework: readonly AgentInfoFrameworkToolEntry[];
    readonly reserved: readonly string[];
  };
  readonly version: 1;
  readonly workflow: {
    readonly enabled: boolean;
    readonly toolName: string;
  };
  readonly workspace: {
    readonly resourceRoot: unknown;
    readonly rootEntries: readonly string[];
  };
}

export type MessageTurnStatus = "completed" | "failed" | "waiting";

export interface MessageTurnResult {
  readonly eventsRead: number;
  readonly failureMessage?: string;
  readonly message?: string;
  readonly status: MessageTurnStatus;
}

interface ApiErrorPayload {
  readonly error?: string;
}

interface MessageCompletedStreamEvent {
  readonly data: {
    readonly finishReason?: string;
    readonly message: string | null;
  };
  readonly type: "message.completed";
}

interface SessionFailedStreamEvent {
  readonly data: {
    readonly message: string;
  };
  readonly type: "session.failed";
}

interface SessionCompletedStreamEvent {
  readonly type: "session.completed";
}

interface SessionWaitingStreamEvent {
  readonly type: "session.waiting";
}

type MessageStreamEvent =
  | MessageCompletedStreamEvent
  | SessionCompletedStreamEvent
  | SessionFailedStreamEvent
  | SessionWaitingStreamEvent
  | {
      readonly data?: unknown;
      readonly type: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseApiError(statusCode: number, body: unknown): Error {
  if (isRecord(body)) {
    const payload = body as ApiErrorPayload;
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return new Error(payload.error);
    }
  }

  return new Error(`Request failed (${statusCode}).`);
}

function parseResponseTextAsJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
  });

  const body = (await response.json()) as unknown;

  if (!response.ok) {
    throw parseApiError(response.status, body);
  }

  return body as T;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  return value;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  return value;
}

function expectOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Invalid JSON response for ${path}.`);
  }
}

function expectOrigin(value: unknown): "authored" | "framework" {
  if (value !== "authored" && value !== "framework") {
    throw new Error(`Invalid JSON response for ${INFO_API_PATH}.`);
  }

  return value;
}

function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  return value;
}

function assertSource(value: unknown): Record<string, unknown> {
  const source = expectRecord(value, INFO_API_PATH);
  expectOptionalString(source.exportName, INFO_API_PATH);
  expectString(source.logicalPath, INFO_API_PATH);
  expectOptionalString(source.sourceId, INFO_API_PATH);
  expectString(source.sourceKind, INFO_API_PATH);
  return source;
}

function assertNamedSource(value: unknown): Record<string, unknown> {
  const source = assertSource(value);
  expectString(source.name, INFO_API_PATH);
  return source;
}

function assertDynamicResolvers(value: unknown): void {
  for (const entry of expectArray(value, INFO_API_PATH)) {
    const resolver = assertSource(entry);
    expectArray(resolver.eventNames, INFO_API_PATH).forEach((eventName) => {
      expectString(eventName, INFO_API_PATH);
    });
    expectOrigin(resolver.origin);
    expectString(resolver.slug, INFO_API_PATH);
  }
}

function assertToolEntries(value: unknown): void {
  for (const entry of expectArray(value, INFO_API_PATH)) {
    const tool = assertNamedSource(entry);
    expectString(tool.description, INFO_API_PATH);
    expectBoolean(tool.hasAuth, INFO_API_PATH);
    expectBoolean(tool.hasExecute, INFO_API_PATH);
    expectBoolean(tool.hasModelOutputProjection, INFO_API_PATH);
    expectBoolean(tool.hasOutputSchema, INFO_API_PATH);
    expectOrigin(tool.origin);
    expectBoolean(tool.replacesFrameworkTool, INFO_API_PATH);
    expectBoolean(tool.requiresApproval, INFO_API_PATH);
  }
}

function assertChannelEntries(value: unknown): void {
  for (const entry of expectArray(value, INFO_API_PATH)) {
    const channel = assertNamedSource(entry);
    expectOptionalString(channel.adapterKind, INFO_API_PATH);
    expectString(channel.method, INFO_API_PATH);
    expectOrigin(channel.origin);
    expectString(channel.urlPath, INFO_API_PATH);
  }
}

function ensureAgentInformation(value: unknown): AgentInformation {
  const payload = expectRecord(value, INFO_API_PATH);
  if (
    expectString(payload.kind, INFO_API_PATH) !== "eve-agent-info" ||
    expectNumber(payload.version, INFO_API_PATH) !== 1
  ) {
    throw new Error(`Invalid JSON response for ${INFO_API_PATH}.`);
  }
  const mode = expectString(payload.mode, INFO_API_PATH);
  if (mode !== "development" && mode !== "production") {
    throw new Error(`Invalid JSON response for ${INFO_API_PATH}.`);
  }

  const agent = expectRecord(payload.agent, INFO_API_PATH);
  expectString(agent.agentRoot, INFO_API_PATH);
  expectString(agent.appRoot, INFO_API_PATH);
  expectOptionalString(agent.description, INFO_API_PATH);
  if (agent.configSource !== undefined) {
    assertSource(agent.configSource);
  }

  const model = expectRecord(agent.model, INFO_API_PATH);
  expectString(model.id, INFO_API_PATH);
  if (model.contextWindowTokens !== undefined) {
    expectNumber(model.contextWindowTokens, INFO_API_PATH);
  }
  if (model.source !== undefined) {
    assertSource(model.source);
  }
  expectString(agent.name, INFO_API_PATH);

  const channels = expectRecord(payload.channels, INFO_API_PATH);
  assertChannelEntries(channels.authored);
  assertChannelEntries(channels.available);
  expectArray(channels.disabledFramework, INFO_API_PATH).forEach((name) => {
    expectString(name, INFO_API_PATH);
  });
  assertChannelEntries(channels.framework);

  expectArray(payload.connections, INFO_API_PATH).forEach((entry) => {
    const connection = assertSource(entry);
    expectString(connection.connectionName, INFO_API_PATH);
    expectString(connection.description, INFO_API_PATH);
    expectBoolean(connection.hasApproval, INFO_API_PATH);
    expectBoolean(connection.hasAuthorization, INFO_API_PATH);
    expectBoolean(connection.hasHeaders, INFO_API_PATH);
    expectString(connection.protocol, INFO_API_PATH);
    expectString(connection.url, INFO_API_PATH);
  });

  const diagnostics = expectRecord(payload.diagnostics, INFO_API_PATH);
  expectNumber(diagnostics.discoveryErrors, INFO_API_PATH);
  expectNumber(diagnostics.discoveryWarnings, INFO_API_PATH);

  expectArray(payload.hooks, INFO_API_PATH).forEach((entry) => {
    const hook = assertSource(entry);
    expectArray(hook.eventNames, INFO_API_PATH);
    expectString(hook.slug, INFO_API_PATH);
  });

  const instructions = expectRecord(payload.instructions, INFO_API_PATH);
  assertDynamicResolvers(instructions.dynamic);
  if (instructions.static !== null) {
    const staticInstructions = assertNamedSource(instructions.static);
    expectString(staticInstructions.markdown, INFO_API_PATH);
  }

  if (payload.sandbox !== null) {
    const sandbox = assertSource(payload.sandbox);
    expectOptionalString(sandbox.backendKind, INFO_API_PATH);
    expectOptionalString(sandbox.description, INFO_API_PATH);
    expectBoolean(sandbox.hasBootstrap, INFO_API_PATH);
    expectBoolean(sandbox.hasOnSession, INFO_API_PATH);
  }

  expectArray(payload.schedules, INFO_API_PATH).forEach((entry) => {
    const schedule = assertNamedSource(entry);
    expectString(schedule.cron, INFO_API_PATH);
    expectBoolean(schedule.hasRun, INFO_API_PATH);
    expectOptionalString(schedule.markdown, INFO_API_PATH);
  });

  const skills = expectRecord(payload.skills, INFO_API_PATH);
  expectArray(skills.static, INFO_API_PATH).forEach((entry) => {
    const skill = assertNamedSource(entry);
    expectString(skill.description, INFO_API_PATH);
    expectString(skill.markdown, INFO_API_PATH);
  });
  assertDynamicResolvers(skills.dynamic);

  const subagents = expectRecord(payload.subagents, INFO_API_PATH);
  expectArray(subagents.local, INFO_API_PATH).forEach((entry) => {
    const subagent = assertNamedSource(entry);
    expectString(subagent.description, INFO_API_PATH);
    expectString(subagent.entryPath, INFO_API_PATH);
    expectString(subagent.nodeId, INFO_API_PATH);
    expectString(subagent.rootPath, INFO_API_PATH);
  });
  expectNumber(subagents.total, INFO_API_PATH);

  const tools = expectRecord(payload.tools, INFO_API_PATH);
  assertToolEntries(tools.authored);
  assertToolEntries(tools.available);
  expectArray(tools.disabledFramework, INFO_API_PATH).forEach((name) => {
    expectString(name, INFO_API_PATH);
  });
  assertDynamicResolvers(tools.dynamic);
  assertToolEntries(tools.framework);
  expectArray(tools.reserved, INFO_API_PATH).forEach((name) => {
    expectString(name, INFO_API_PATH);
  });

  const workflow = expectRecord(payload.workflow, INFO_API_PATH);
  expectBoolean(workflow.enabled, INFO_API_PATH);
  expectString(workflow.toolName, INFO_API_PATH);

  const workspace = expectRecord(payload.workspace, INFO_API_PATH);
  expectArray(workspace.rootEntries, INFO_API_PATH).forEach((entry) => {
    expectString(entry, INFO_API_PATH);
  });

  return value as AgentInformation;
}

function createSessionMessageStreamPath(sessionId: string): string {
  return `${SESSION_STREAM_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/stream`;
}

function resolveRuntimeOrigin(): string {
  const location = globalThis.location;

  if (location && typeof location.origin === "string" && location.origin.length > 0) {
    return location.origin;
  }

  return "http://localhost";
}

function resolveSessionMessageStreamUrl(input: {
  readonly sessionId: string;
  readonly startIndex?: number;
}): string {
  const path = createSessionMessageStreamPath(input.sessionId);
  const url = new URL(path, resolveRuntimeOrigin());

  if (typeof input.startIndex === "number" && Number.isInteger(input.startIndex)) {
    if (input.startIndex > 0) {
      url.searchParams.set("startIndex", String(input.startIndex));
    }
  }

  return url.toString();
}

function parseMessageStreamEvent(line: string): MessageStreamEvent {
  const parsed = JSON.parse(line) as unknown;

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Received an invalid message stream event.");
  }

  return parsed as MessageStreamEvent;
}

function isMessageCompletedEvent(event: MessageStreamEvent): event is MessageCompletedStreamEvent {
  if (event.type !== "message.completed") {
    return false;
  }

  return isRecord(event.data) && "message" in event.data;
}

function isSessionFailedEvent(event: MessageStreamEvent): event is SessionFailedStreamEvent {
  if (event.type !== "session.failed") {
    return false;
  }

  return isRecord(event.data) && "message" in event.data;
}

/**
 * Loads the package-owned agent inspection payload.
 */
export async function loadAgentInformation(): Promise<AgentInformation> {
  return ensureAgentInformation(await requestJson<unknown>(INFO_API_PATH));
}

/**
 * Starts or resumes one message turn. When `sessionId` and
 * `continuationToken` are both present the call resumes that session via
 * `POST /eve/v1/session/:sessionId`; otherwise it opens a new session via
 * `POST /eve/v1/session`.
 */
export async function sendMessage(input: SendMessageInput): Promise<SentMessageResult> {
  const isContinue =
    typeof input.sessionId === "string" &&
    input.sessionId.length > 0 &&
    typeof input.continuationToken === "string" &&
    input.continuationToken.length > 0;

  const path = isContinue ? createSessionContinuePath(input.sessionId as string) : SESSION_API_PATH;

  const body: {
    continuationToken?: string;
    message: string;
  } = {
    message: input.message,
  };

  if (isContinue) {
    body.continuationToken = input.continuationToken as string;
  }

  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    throw parseApiError(response.status, payload);
  }

  if (!isRecord(payload)) {
    throw new Error(`Invalid JSON response for ${path}.`);
  }

  const sessionIdHeader = response.headers.get(EVE_SESSION_ID_HEADER);
  const continuationToken = payload.continuationToken;
  const sessionId = payload.sessionId;

  const result: {
    continuationToken?: string;
    sessionId?: string;
  } = {};

  if (typeof sessionIdHeader === "string" && sessionIdHeader.length > 0) {
    result.sessionId = sessionIdHeader;
  } else if (typeof sessionId === "string" && sessionId.length > 0) {
    result.sessionId = sessionId;
  }

  if (typeof continuationToken === "string" && continuationToken.length > 0) {
    result.continuationToken = continuationToken;
  }

  return result;
}

/**
 * Reads one session stream until the current turn reaches a boundary event.
 */
export async function readSessionTurn(input: {
  readonly onEvent?: (
    event: MessageStreamEvent,
    info: {
      readonly eventsRead: number;
    },
  ) => void;
  readonly sessionId: string;
  readonly startIndex?: number;
  readonly timeoutMs?: number;
}): Promise<MessageTurnResult> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_SESSION_TURN_TIMEOUT_MS;
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const streamUrl = resolveSessionMessageStreamUrl({
      sessionId: input.sessionId,
      startIndex: input.startIndex,
    });
    const response = await fetch(streamUrl, {
      headers: {
        accept: MESSAGE_STREAM_CONTENT_TYPE,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const parsedBody = parseResponseTextAsJson(body);
      if (parsedBody !== undefined) {
        throw parseApiError(response.status, parsedBody);
      }
      throw new Error(body.length > 0 ? body : `Request failed (${response.status}).`);
    }

    if (response.body === null) {
      throw new Error("Message stream response did not include a readable body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventsRead = 0;
    let failureMessage: string | undefined;
    let message: string | undefined;
    let status: MessageTurnStatus | null = null;

    const pushLine = (line: string): void => {
      const event = parseMessageStreamEvent(line);
      eventsRead += 1;
      input.onEvent?.(event, { eventsRead });

      if (isMessageCompletedEvent(event)) {
        const finishReason = event.data.finishReason;
        if (finishReason !== "tool-calls") {
          const completedMessage = event.data.message;
          if (typeof completedMessage === "string" && completedMessage.length > 0) {
            message = completedMessage;
          }
        }
        return;
      }

      if (isSessionFailedEvent(event)) {
        if (typeof event.data.message === "string" && event.data.message.length > 0) {
          failureMessage = event.data.message;
        }
        status = "failed";
        return;
      }

      if (event.type === "session.completed") {
        status = "completed";
        return;
      }

      if (event.type === "session.waiting") {
        status = "waiting";
      }
    };

    try {
      while (status === null) {
        const { done, value } = await reader.read();

        if (done) {
          buffer += decoder.decode();
          break;
        }

        if (value !== undefined) {
          buffer += decoder.decode(value, {
            stream: true,
          });
        }

        while (status === null) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }

          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length === 0) {
            continue;
          }

          pushLine(line);
        }
      }

      if (status === null) {
        const trailingLine = buffer.trim();
        if (trailingLine.length > 0) {
          pushLine(trailingLine);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (status === null) {
      throw new Error("Message stream ended before a turn boundary event was received.");
    }

    return {
      eventsRead,
      failureMessage,
      message,
      status,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Timed out after waiting ${timeoutMs}ms for a session response.`);
    }

    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

/**
 * Returns a stable, user-facing error string for UI surfaces.
 */
export function toErrorMessage(error: unknown): string {
  return stringifyError(error);
}
