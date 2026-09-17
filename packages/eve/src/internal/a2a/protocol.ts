import { z } from "#compiled/zod/index.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";

export const A2A_VERSION = "1.0";
export const A2A_BODY_LIMIT = 1_048_576;
const id = z.string().min(1).max(1024);
export const taskStateSchema = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);
export const partSchema = z
  .object({
    text: z.string().optional(),
    data: jsonValueSchema.optional(),
    url: z.string().optional(),
    raw: z.string().optional(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .refine(
    (part) => ["text", "data", "url", "raw"].filter((key) => Object.hasOwn(part, key)).length === 1,
    "A part must contain exactly one of text, data, url, or raw.",
  );
export const messageSchema = z.object({
  messageId: id,
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(partSchema).min(1).max(256),
  taskId: id.optional(),
  contextId: id.optional(),
  metadata: jsonObjectSchema.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(id).max(100).optional(),
});
export const artifactSchema = z.object({
  artifactId: id,
  parts: z.array(partSchema).max(256),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
  extensions: z.array(z.string()).optional(),
});
export const taskSchema = z.object({
  id,
  contextId: id.optional(),
  status: z.object({
    state: taskStateSchema,
    message: messageSchema.optional(),
    timestamp: z.iso.datetime({ offset: true }).optional(),
  }),
  artifacts: z.array(artifactSchema).optional(),
  history: z.array(messageSchema).optional(),
  metadata: jsonObjectSchema.optional(),
});
export const securitySchemeSchema = z.union([
  z.object({
    apiKeySecurityScheme: z.object({
      name: id,
      location: z.enum(["header", "query", "cookie"]),
      description: z.string().optional(),
    }),
  }),
  z.object({
    httpAuthSecurityScheme: z.object({
      scheme: id,
      bearerFormat: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
  z.object({
    oauth2SecurityScheme: z.object({
      flows: jsonObjectSchema,
      oauth2MetadataUrl: z.url().optional(),
      description: z.string().optional(),
    }),
  }),
  z.object({
    openIdConnectSecurityScheme: z.object({
      openIdConnectUrl: z.url(),
      description: z.string().optional(),
    }),
  }),
  z.object({ mtlsSecurityScheme: z.object({ description: z.string().optional() }) }),
]);
export const securityRequirementSchema = z.object({
  schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })),
});
export const skillSchema = z.object({
  id,
  name: id,
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(securityRequirementSchema).optional(),
});
export const agentCardSchema = z.object({
  name: id,
  description: z.string(),
  version: id,
  supportedInterfaces: z
    .array(
      z.object({ url: z.url(), protocolBinding: id, protocolVersion: id, tenant: id.optional() }),
    )
    .min(1)
    .max(32),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
    extensions: z
      .array(
        z.object({
          uri: z.url(),
          required: z.boolean().optional(),
          description: z.string().optional(),
          params: jsonObjectSchema.optional(),
        }),
      )
      .optional(),
  }),
  defaultInputModes: z.array(id).min(1),
  defaultOutputModes: z.array(id).min(1),
  skills: z.array(skillSchema).min(1),
  provider: z.object({ organization: id, url: z.url() }).optional(),
  documentationUrl: z.url().optional(),
  iconUrl: z.url().optional(),
  securitySchemes: z.record(z.string(), securitySchemeSchema).optional(),
  securityRequirements: z.array(securityRequirementSchema).optional(),
});
export type A2AMessage = z.infer<typeof messageSchema>;
export type A2ATask = z.infer<typeof taskSchema>;
export type A2AAgentCard = z.infer<typeof agentCardSchema>;
export type A2APart = z.infer<typeof partSchema>;
export type A2ATaskState = z.infer<typeof taskStateSchema>;

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite()]),
  method: id,
  params: jsonObjectSchema.optional(),
});
export const sendMessageSchema = z.object({
  message: messageSchema,
  tenant: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
  configuration: z
    .object({
      returnImmediately: z.boolean().optional(),
      historyLength: z.number().int().min(0).optional(),
      acceptedOutputModes: z.array(z.string()).optional(),
      taskPushNotificationConfig: jsonObjectSchema.optional(),
    })
    .optional(),
});
export const taskRequestSchema = z.object({
  id,
  tenant: z.string().optional(),
  historyLength: z.number().int().min(0).optional(),
});
export const listTasksSchema = z.object({
  tenant: z.string().optional(),
  contextId: id.optional(),
  status: taskStateSchema.optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
  pageToken: z.string().max(4096).optional(),
  historyLength: z.number().int().min(0).optional(),
  statusTimestampAfter: z.iso.datetime({ offset: true }).optional(),
  includeArtifacts: z.boolean().default(false),
});
export type A2AListTasksRequest = z.infer<typeof listTasksSchema>;

export class A2AError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "A2AError";
  }
}
export function isTerminalTask(task: A2ATask): boolean {
  return [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(task.status.state);
}
export function isInterruptedTask(task: A2ATask): boolean {
  return (
    task.status.state === "TASK_STATE_INPUT_REQUIRED" ||
    task.status.state === "TASK_STATE_AUTH_REQUIRED"
  );
}
export function parseParams<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new A2AError(-32602, "Invalid params.");
  return parsed.data;
}
export async function readBoundedJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) throw new A2AError(-32700, "Parse error.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > A2A_BODY_LIMIT) throw new A2AError(-32600, "Request exceeds the 1 MiB limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new A2AError(-32700, "Parse error.");
  }
}
