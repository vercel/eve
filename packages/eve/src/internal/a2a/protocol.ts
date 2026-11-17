import { z } from "#compiled/zod/index.js";
import type { JsonValue } from "#shared/json.js";

export const A2A_PROTOCOL_VERSION = "1.0";

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

export type A2aErrorDetail = { readonly "@type": string } & { readonly [key: string]: JsonValue };

export interface A2aErrorOptions {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly details?: readonly A2aErrorDetail[];
}

export class A2aError extends Error {
  readonly code: number;
  readonly #options: A2aErrorOptions;

  constructor(code: number, message: string, options: A2aErrorOptions = {}) {
    super(message);
    this.name = "A2aError";
    this.code = code;
    this.#options = options;
  }

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

export function isSettledForBlocking(state: TaskState): boolean {
  return (
    isTerminalState(state) ||
    state === "TASK_STATE_INPUT_REQUIRED" ||
    state === "TASK_STATE_AUTH_REQUIRED"
  );
}

const MAX_ID_CHARS = 256;
const MAX_TASK_ID_CHARS = 2048;
const MAX_PARTS = 64;

const metadataSchema = z.record(z.string(), z.json());

const int32 = z.preprocess(
  (value) => (typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value),
  z.number().int(),
);

export const partSchema = z
  .object({
    text: z.string().optional(),
    raw: z.base64().optional(),
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
  readonly nextPageToken: string;
  readonly pageSize: number;
  readonly totalSize: number;
}

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

export function a2aTimestamp(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}
