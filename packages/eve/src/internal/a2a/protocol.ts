/**
 * The subset of A2A protocol v1.0 (JSON-RPC binding) that eve serves.
 *
 * The normative source is `specification/a2a.proto` at a2aproject/A2A v1.0.1. JSON field names are
 * the ProtoJSON camelCase of the proto fields; enums are SCREAMING_SNAKE_CASE; `oneof` members
 * discriminate by which key is present, not by a `kind` field.
 */
import { z } from "#compiled/zod/index.js";
import type { JsonValue } from "#shared/json.js";

/** The `Major.Minor` protocol version this module speaks. */
export const A2A_PROTOCOL_VERSION = "1.0";

/** The version an empty `A2A-Version` means (spec 3.2.6): 0.3 clients predate the header. */
export const A2A_ABSENT_VERSION = "0.3";

export const A2A_JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  extensionSupportRequired: -32008,
  versionNotSupported: -32009,
} as const;

/** `ErrorInfo.reason` for each A2A error: the type name in UPPER_SNAKE_CASE, without "Error". */
const A2A_ERROR_REASONS: Readonly<Record<number, string>> = {
  [A2A_JSON_RPC_ERRORS.taskNotFound]: "TASK_NOT_FOUND",
  [A2A_JSON_RPC_ERRORS.taskNotCancelable]: "TASK_NOT_CANCELABLE",
  [A2A_JSON_RPC_ERRORS.pushNotificationNotSupported]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [A2A_JSON_RPC_ERRORS.unsupportedOperation]: "UNSUPPORTED_OPERATION",
  [A2A_JSON_RPC_ERRORS.contentTypeNotSupported]: "CONTENT_TYPE_NOT_SUPPORTED",
  [A2A_JSON_RPC_ERRORS.invalidAgentResponse]: "INVALID_AGENT_RESPONSE",
  [A2A_JSON_RPC_ERRORS.extendedAgentCardNotConfigured]: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  [A2A_JSON_RPC_ERRORS.extensionSupportRequired]: "EXTENSION_SUPPORT_REQUIRED",
  [A2A_JSON_RPC_ERRORS.versionNotSupported]: "VERSION_NOT_SUPPORTED",
};

/** One `error.data` entry: a ProtoJSON `Any`, such as a `google.rpc.ErrorInfo` (spec 9.5). */
export type A2aErrorDetail = { readonly "@type": string } & { readonly [key: string]: JsonValue };

export interface A2aErrorOptions {
  /** `ErrorInfo.metadata`, for A2A errors. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Further detail entries, after the `ErrorInfo`. */
  readonly details?: readonly A2aErrorDetail[];
}

/** A protocol error the dispatcher renders as a JSON-RPC error object. */
export class A2aError extends Error {
  readonly code: number;
  readonly #options: A2aErrorOptions;

  constructor(code: number, message: string, options: A2aErrorOptions = {}) {
    super(message);
    this.name = "A2aError";
    this.code = code;
    this.#options = options;
  }

  /**
   * `error.data`: an array of typed details. An A2A error (`-32001`..`-32009`) leads with the
   * `google.rpc.ErrorInfo` the spec requires; a JSON-RPC error carries only what it was given.
   */
  get data(): readonly A2aErrorDetail[] | undefined {
    const reason = A2A_ERROR_REASONS[this.code];
    const info: A2aErrorDetail[] =
      reason === undefined
        ? []
        : [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              domain: "a2a-protocol.org",
              reason,
              ...(this.#options.metadata !== undefined && { metadata: this.#options.metadata }),
            },
          ];
    const data = [...info, ...(this.#options.details ?? [])];
    return data.length === 0 ? undefined : data;
  }

  static taskNotFound(): A2aError {
    // Unknown, expired, and foreign tasks read the same so a response never confirms
    // that another caller's task exists.
    return new A2aError(A2A_JSON_RPC_ERRORS.taskNotFound, "Task not found.");
  }
}

export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Terminal or interrupted: where a blocking `SendMessage` may return. */
export function isSettledForBlocking(state: TaskState): boolean {
  return (
    isTerminalState(state) ||
    state === "TASK_STATE_INPUT_REQUIRED" ||
    state === "TASK_STATE_AUTH_REQUIRED"
  );
}

// ---------------------------------------------------------------------------------------------
// Wire objects
// ---------------------------------------------------------------------------------------------

const MAX_ID_CHARS = 256;
/** A task ID embeds its context's ID and its first message's (`ids.ts`), so it runs longer. */
const MAX_TASK_ID_CHARS = 2048;
const MAX_PARTS = 64;

const metadataSchema = z.record(z.string(), z.json());

/** ProtoJSON writes int32 as a number but parsers accept its decimal string too. */
const int32 = z.preprocess(
  (value) => (typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value),
  z.number().int(),
);

/** `Part`: exactly one of `text`, `raw`, `url`, or `data`. */
export const partSchema = z
  .object({
    text: z.string().optional(),
    raw: z.base64().optional(),
    // Only fetchable web URLs: eve resolves file URLs itself, and other schemes (including eve's
    // internal attachment refs) must never arrive from a caller.
    url: z.url({ protocol: /^https?$/u }).optional(),
    data: z.json().optional(),
    metadata: metadataSchema.optional(),
    filename: z.string().max(MAX_ID_CHARS).optional(),
    mediaType: z.string().max(MAX_ID_CHARS).optional(),
  })
  .refine(
    (part) =>
      [part.text, part.raw, part.url, part.data].filter((value) => value !== undefined).length ===
      1,
    { message: "A part must set exactly one of text, raw, url, or data." },
  );

/** One `Part`, as eve reads and writes it. */
export interface Part {
  readonly text?: string;
  readonly raw?: string;
  readonly url?: string;
  readonly data?: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly filename?: string;
  readonly mediaType?: string;
}

export const messageSchema = z.object({
  messageId: z.string().min(1).max(MAX_ID_CHARS),
  contextId: z.string().min(1).max(MAX_ID_CHARS).optional(),
  taskId: z.string().min(1).max(MAX_TASK_ID_CHARS).optional(),
  // ProtoJSON omits a default enum, so an unset role arrives absent; it reads as the user's.
  role: z.enum(["ROLE_USER", "ROLE_AGENT", "ROLE_UNSPECIFIED"]).default("ROLE_UNSPECIFIED"),
  parts: z.array(partSchema).min(1).max(MAX_PARTS),
  metadata: metadataSchema.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string().max(MAX_TASK_ID_CHARS)).optional(),
});

export type Message = Omit<z.infer<typeof messageSchema>, "parts"> & {
  readonly parts: readonly Part[];
};

export interface Artifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly Part[];
  readonly metadata?: Record<string, JsonValue>;
  readonly extensions?: readonly string[];
}

export interface TaskStatus {
  readonly state: TaskState;
  readonly message?: Message;
  /** ISO 8601 UTC with millisecond precision. */
  readonly timestamp?: string;
}

export interface Task {
  readonly id: string;
  readonly contextId: string;
  readonly status: TaskStatus;
  readonly artifacts?: readonly Artifact[];
  readonly history?: readonly Message[];
  readonly metadata?: Record<string, JsonValue>;
}

export interface ListTasksResponse {
  readonly tasks: readonly Task[];
  /** Empty when this is the last page. */
  readonly nextPageToken: string;
  readonly pageSize: number;
  readonly totalSize: number;
}

/** One SSE event of `SendStreamingMessage` or `SubscribeToTask`: exactly one member is set. */
export type StreamResponse =
  | { readonly task: Task }
  | {
      readonly statusUpdate: {
        readonly taskId: string;
        readonly contextId: string;
        readonly status: TaskStatus;
      };
    }
  | {
      readonly artifactUpdate: {
        readonly taskId: string;
        readonly contextId: string;
        readonly artifact: Artifact;
        readonly append?: boolean;
        readonly lastChunk?: boolean;
      };
    };

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const tenantSchema = z.string().max(MAX_ID_CHARS).optional();
const historyLengthSchema = int32.pipe(z.number().nonnegative()).optional();

export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const satisfies readonly TaskState[];

export const sendMessageRequestSchema = z.object({
  tenant: tenantSchema,
  message: messageSchema,
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      // Push notifications aren't supported; a request that asks for one is refused explicitly.
      taskPushNotificationConfig: z.unknown().optional(),
      historyLength: historyLengthSchema,
      returnImmediately: z.boolean().optional(),
    })
    .optional(),
  metadata: metadataSchema.optional(),
});

export const getTaskRequestSchema = z.object({
  tenant: tenantSchema,
  id: z.string().min(1).max(MAX_TASK_ID_CHARS),
  historyLength: historyLengthSchema,
});

export const cancelTaskRequestSchema = z.object({
  tenant: tenantSchema,
  id: z.string().min(1).max(MAX_TASK_ID_CHARS),
  metadata: metadataSchema.optional(),
});

export const listTasksRequestSchema = z.object({
  tenant: tenantSchema,
  contextId: z.string().min(1).max(MAX_ID_CHARS).optional(),
  // UNSPECIFIED is the proto default: no filter.
  status: z.enum([...TASK_STATES, "TASK_STATE_UNSPECIFIED"]).optional(),
  pageSize: int32.pipe(z.number().min(1).max(100)).optional(),
  pageToken: z.string().max(1_024).optional(),
  historyLength: historyLengthSchema,
  statusTimestampAfter: z.iso.datetime().optional(),
  includeArtifacts: z.boolean().optional(),
});

export const subscribeToTaskRequestSchema = z.object({
  tenant: tenantSchema,
  id: z.string().min(1).max(MAX_TASK_ID_CHARS),
});

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type SubscribeToTaskRequest = z.infer<typeof subscribeToTaskRequestSchema>;
export type GetTaskRequest = z.infer<typeof getTaskRequestSchema>;
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>;

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type JsonRpcId = string | number | null;

/** `ProtoJSON` timestamp: ISO 8601 UTC, millisecond precision. */
export function a2aTimestamp(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}
