import { toOutputSchema } from "#tools/schema.js";
import { createHash } from "node:crypto";
import { requestPublicUrl, validatePublicUrl } from "#execution/web-fetch/request.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import {
  A2AError,
  A2A_VERSION,
  agentCardSchema,
  taskSchema,
  messageSchema,
  type A2AAgentCard,
  type A2ATask,
  type A2AMessage,
} from "#internal/a2a/protocol.js";
import type { A2AAgentDefinitionInput } from "#public/definitions/a2a-agent.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { z } from "#compiled/zod/index.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

export interface A2AEndpoint {
  readonly url: string;
  readonly tenant?: string;
  readonly contract: string;
}
interface CachedCard {
  card: A2AAgentCard;
  etag?: string;
  modified?: string;
  expires: number;
}
const cards = new Map<string, CachedCard>();

export async function discoverA2AAgent(
  definition: A2AAgentDefinitionInput,
  pinned?: A2AEndpoint,
): Promise<A2AEndpoint> {
  const configured = typeof definition.url === "function" ? await definition.url() : definition.url;
  const url = new URL(configured);
  if (url.pathname === "/" && !url.search) url.pathname = "/.well-known/agent-card.json";
  const key = url.toString();
  let cached = cards.get(key);
  if (cached === undefined || cached.expires <= Date.now()) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    else if (cached?.modified) headers["if-modified-since"] = cached.modified;
    // Discovery is public: authored headers and invocation credentials never accompany it.
    const response = await requestPublicUrl(key, {
      headers,
      maxResponseSize: 1_048_576,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      allowLoopback: isEveDevEnvironment(),
    });
    if (response.status !== 304 || cached === undefined) {
      if (!response.ok)
        throw new A2AError(-32006, `Agent Card request failed with HTTP ${response.status}.`);
      const parsed = agentCardSchema.safeParse(await response.json());
      if (!parsed.success) throw new A2AError(-32006, "Invalid A2A 1.0 Agent Card.");
      cached = { card: parsed.data, expires: 0 };
    }
    cached.etag = response.headers.get("etag") ?? cached.etag;
    cached.modified = response.headers.get("last-modified") ?? cached.modified;
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)?.[1];
    cached.expires =
      Date.now() +
      (/no-cache|no-store/i.test(cacheControl)
        ? 0
        : Math.max(
            0,
            Math.min(Number(maxAge ?? 0), 300) - Number(response.headers.get("age") ?? 0),
          ) * 1000);
    if (/no-store/i.test(cacheControl)) cards.delete(key);
    else {
      if (cards.size >= 128) cards.delete(cards.keys().next().value!);
      cards.set(key, cached);
    }
  }
  const card = cached.card;
  if (card.capabilities.extensions?.some((extension) => extension.required))
    throw new A2AError(-32008, "Agent Card requires an unsupported A2A extension.");
  const selected = card.supportedInterfaces.find(
    (entry) => entry.protocolBinding === "JSONRPC" && entry.protocolVersion === A2A_VERSION,
  );
  if (selected === undefined)
    throw new A2AError(-32009, "Agent Card does not offer A2A 1.0 JSONRPC.");
  const destination = validatePublicUrl(selected.url, isEveDevEnvironment());
  if (
    destination.origin !== url.origin &&
    !definition.allowedInterfaceOrigins?.includes(destination.origin)
  )
    throw new A2AError(
      -32006,
      "Agent Card interface origin is not approved. Set allowedInterfaceOrigins to trust this exact origin.",
    );
  const endpoint: A2AEndpoint = {
    url: selected.url,
    tenant: selected.tenant,
    contract: createHash("sha256")
      .update(
        JSON.stringify([
          selected,
          card.securitySchemes,
          card.securityRequirements,
          card.capabilities.extensions,
        ]),
      )
      .digest("hex"),
  };
  if (
    pinned !== undefined &&
    (pinned.url !== endpoint.url || pinned.contract !== endpoint.contract)
  )
    throw new A2AError(-32006, "Agent Card changed during an active task. Start a new subagent.");
  return endpoint;
}
const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: jsonValueSchema.optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});
export async function callA2A(input: {
  readonly definition: A2AAgentDefinitionInput;
  readonly endpoint: A2AEndpoint;
  readonly ctx: ToolContext;
  readonly method: "SendMessage" | "GetTask" | "CancelTask";
  readonly params: JsonObject;
}): Promise<{ task: A2ATask } | { message: A2AMessage }> {
  const { definition, endpoint, ctx } = input;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "A2A-Version": A2A_VERSION,
  });
  if (typeof definition.headers === "function") {
    for (const [key, value] of Object.entries(await definition.headers(ctx)))
      headers.set(key, value);
  } else {
    for (const [key, value] of Object.entries(definition.headers ?? {}))
      headers.set(key, await (typeof value === "function" ? value(ctx) : value));
  }
  const provider =
    typeof definition.auth === "function" ? await definition.auth(ctx) : definition.auth;
  const options = {
    connection: { url: endpoint.url },
    authKey: `a2a:${ctx.toolName.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
  };
  if (provider !== undefined)
    headers.set("authorization", `Bearer ${(await ctx.getToken(provider, options)).token}`);
  headers.set("A2A-Version", A2A_VERSION);
  headers.set("content-type", "application/json");
  const id = crypto.randomUUID();
  const response = await requestPublicUrl(endpoint.url, {
    headers: Object.fromEntries(headers),
    method: "POST",
    redirect: "manual",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: input.method,
      params: {
        ...input.params,
        tenant: endpoint.tenant,
      },
    }),
    maxResponseSize: 4_194_304,
    signal: AbortSignal.timeout(30_000),
    allowLoopback: isEveDevEnvironment(),
  });
  if (response.status === 401 && provider !== undefined) ctx.requireAuth(provider, options);
  if (!response.ok) throw new A2AError(-32006, `A2A request failed with HTTP ${response.status}.`);
  const parsed = rpcResponseSchema.safeParse(await response.json());
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    (parsed.data.error === undefined) === (parsed.data.result === undefined)
  )
    throw new A2AError(-32006, "Invalid A2A JSON-RPC response.");
  if (parsed.data.error)
    throw new A2AError(
      parsed.data.error.code,
      `A2A operation failed (code ${parsed.data.error.code}).`,
    );
  const raw = input.method === "SendMessage" ? parsed.data.result : { task: parsed.data.result };
  const result = z
    .union([z.object({ task: taskSchema }), z.object({ message: messageSchema })])
    .safeParse(raw);
  if (!result.success) throw new A2AError(-32006, "A2A agent returned an invalid task or message.");
  return result.data;
}

export async function a2aResult(
  result: { task: A2ATask } | { message: A2AMessage },
  outputSchema?: JsonObject,
): Promise<JsonValue> {
  const parts =
    "task" in result
      ? (result.task.artifacts?.flatMap((artifact) => artifact.parts) ?? [])
      : result.message.parts;
  if (outputSchema !== undefined) {
    const data = parts.filter((part) => Object.hasOwn(part, "data"));
    if (data.length !== 1)
      throw new A2AError(-32006, "Structured A2A output requires exactly one data part.");
    const value = data[0]!.data!;
    const schema = toOutputSchema(outputSchema)["~standard"];
    if (schema.vendor === "eve")
      throw new A2AError(
        -32006,
        "The output schema cannot be validated locally. Use a supported JSON Schema.",
      );
    const validated = await schema.validate(value);
    if (validated.issues !== undefined)
      throw new A2AError(-32006, "A2A result does not match the requested output schema.");
    return value;
  }
  return parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");
}
