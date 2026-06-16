import { jsonSchema, tool, type ToolSet } from "ai";

import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { passesToolFilter, resolveHeaders } from "#runtime/connections/mcp-client.js";
import {
  HTTP_METHODS,
  type OpenApiOperation,
  operationDescription,
  operationName,
  uniqueName,
} from "#runtime/connections/openapi-operations.js";
import {
  buildInputSchema,
  deref,
  derefSchema,
  isArray,
  type OpenApiParameter,
  type OpenApiRequestBody,
} from "#runtime/connections/openapi-schema.js";
import { applySecurity, resolveSecurity } from "#runtime/connections/openapi-security.js";
import { extractServerUrl, parseSpecDocument } from "#runtime/connections/openapi-spec.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#runtime/connections/types.js";
import { isObject } from "#shared/guards.js";

interface OpenApiToolCache {
  readonly metadata: readonly ConnectionToolMetadata[];
  readonly operations: ReadonlyMap<string, OpenApiOperation>;
  readonly tools: ToolSet;
  readonly baseUrl: string;
}

const SWAGGER_PARAMETER_SCHEMA_KEYS = [
  "default",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "multipleOf",
  "pattern",
  "type",
  "uniqueItems",
] as const;

/**
 * Result of executing an OpenAPI operation. Returned to the model as the
 * tool result so it can react to the status and body of any response,
 * including non-2xx responses.
 */
export interface OpenApiToolResult {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
}

/**
 * A {@link ConnectionClient} that turns an OpenAPI 3.x or Swagger 2.0
 * document into connection tools.
 *
 * Created lazily per-connection per-session. On first use it loads the
 * document (fetching it when `spec` is a URL), dereferences local
 * `$ref` pointers, and maps each operation to a tool whose name is the
 * operation's `operationId`. Tool calls reconstruct the HTTP request —
 * substituting path parameters, appending query parameters, attaching
 * resolved auth and headers — and return the response as a serializable
 * `{ status, statusText, body }`.
 */
export class OpenApiConnectionClient implements ConnectionClient {
  #toolsPromise: Promise<OpenApiToolCache> | undefined;
  #tools: OpenApiToolCache | undefined;
  #connection: ResolvedConnectionDefinition;

  constructor(connection: ResolvedConnectionDefinition) {
    this.#connection = connection;
  }

  /** Loads and parses the OpenAPI document, sharing one in-flight load. */
  async connect(): Promise<OpenApiToolCache> {
    return this.#ensureTools();
  }

  async getToolMetadata(): Promise<readonly ConnectionToolMetadata[]> {
    const cache = await this.#ensureTools();
    return cache.metadata;
  }

  async getTools(): Promise<ToolSet> {
    const cache = await this.#ensureTools();
    return cache.tools;
  }

  async executeTool(toolName: string, args: unknown): Promise<OpenApiToolResult> {
    const cache = await this.#ensureTools();
    const operation = cache.operations.get(toolName);
    if (operation === undefined) {
      throw new Error(
        `Tool "${toolName}" not found in connection "${this.#connection.connectionName}".`,
      );
    }
    return this.#request(operation, cache.baseUrl, isObject(args) ? args : {});
  }

  async close(): Promise<void> {
    this.#toolsPromise = undefined;
    this.#tools = undefined;
  }

  async #ensureTools(): Promise<OpenApiToolCache> {
    if (this.#tools !== undefined) {
      return this.#tools;
    }
    if (this.#toolsPromise !== undefined) {
      return this.#toolsPromise;
    }
    this.#toolsPromise = this.#buildTools();
    try {
      this.#tools = await this.#toolsPromise;
      return this.#tools;
    } catch (error) {
      this.#toolsPromise = undefined;
      throw error;
    }
  }

  async #buildTools(): Promise<OpenApiToolCache> {
    const document = await this.#loadDocument();
    const baseUrl = this.#resolveBaseUrl(document);
    const operations = this.#extractOperations(document);

    const filter = this.#connection.tools;
    const selected =
      filter !== undefined
        ? operations.filter((op) => passesToolFilter(op.toolName, filter))
        : operations;

    const metadata: ConnectionToolMetadata[] = [];
    const operationMap = new Map<string, OpenApiOperation>();
    const tools: ToolSet = {};

    for (const operation of selected) {
      operationMap.set(operation.toolName, operation);
      metadata.push({
        description: operation.description,
        inputSchema: operation.inputSchema,
        name: operation.toolName,
      });
      tools[operation.toolName] = tool({
        description: operation.description,
        inputSchema: jsonSchema(operation.inputSchema),
        execute: async (input: unknown) =>
          this.#request(operation, baseUrl, isObject(input) ? input : {}),
      });
    }

    return { metadata, operations: operationMap, tools, baseUrl };
  }

  /**
   * Resolves the base URL operation paths are joined against.
   *
   * An explicit `baseUrl` on the connection definition always wins. When
   * omitted, the document's first usable `servers` entry is used:
   * `{var}` placeholders are filled from each variable's `default`, and a
   * relative server URL is resolved against the spec's URL (when the spec
   * was given as a URL). Throws when neither yields an absolute URL.
   */
  #resolveBaseUrl(document: Record<string, unknown>): string {
    const explicit = this.#connection.url;
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      return explicit;
    }
    const fromServers = extractServerUrl(document, this.#connection.spec);
    if (fromServers !== undefined) {
      return fromServers;
    }
    throw new Error(
      `OpenAPI connection "${this.#connection.connectionName}" has no base URL: set "baseUrl" or ensure the document declares an absolute "servers" entry or Swagger "host".`,
    );
  }

  async #loadDocument(): Promise<Record<string, unknown>> {
    const spec = this.#connection.spec;
    if (spec === undefined) {
      throw new Error(
        `OpenAPI connection "${this.#connection.connectionName}" is missing its "spec" source.`,
      );
    }

    if (typeof spec !== "string") {
      return spec;
    }

    let response: Response;
    try {
      response = await fetch(spec, {
        headers: { accept: "application/json, application/yaml, text/yaml, */*" },
      });
    } catch (error) {
      throw new Error(
        `OpenAPI connection "${this.#connection.connectionName}" failed to fetch its spec from "${spec}": ${String(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `OpenAPI connection "${this.#connection.connectionName}" failed to fetch its spec from "${spec}": HTTP ${response.status}.`,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = parseSpecDocument(text);
    } catch (error) {
      throw new Error(
        `OpenAPI connection "${this.#connection.connectionName}" spec at "${spec}" could not be parsed as JSON or YAML: ${String(error)}`,
      );
    }
    if (!isObject(parsed)) {
      throw new Error(
        `OpenAPI connection "${this.#connection.connectionName}" spec at "${spec}" is not an OpenAPI document object.`,
      );
    }
    return parsed;
  }

  #extractOperations(document: Record<string, unknown>): OpenApiOperation[] {
    const paths = document.paths;
    if (!isObject(paths)) {
      return [];
    }

    const operations: OpenApiOperation[] = [];
    const usedNames = new Set<string>();

    for (const [pathTemplate, pathItemValue] of Object.entries(paths)) {
      if (!isObject(pathItemValue)) {
        continue;
      }
      const sharedParams = isArray(pathItemValue.parameters) ? pathItemValue.parameters : [];

      for (const method of HTTP_METHODS) {
        const operationValue = pathItemValue[method];
        if (!isObject(operationValue)) {
          continue;
        }

        const toolName = uniqueName(operationName(operationValue, method, pathTemplate), usedNames);

        const opParams = isArray(operationValue.parameters) ? operationValue.parameters : [];
        const rawParameters = [...sharedParams, ...opParams];
        const parameters = this.#resolveParameters(document, rawParameters);
        const requestBody = this.#resolveRequestBody(
          document,
          operationValue.requestBody,
          rawParameters,
        );

        operations.push({
          toolName,
          method,
          pathTemplate,
          description: operationDescription(operationValue),
          parameters,
          requestBody,
          inputSchema: buildInputSchema(parameters, requestBody),
          security: resolveSecurity(document, operationValue),
        });
      }
    }

    return operations;
  }

  #resolveParameters(
    document: Record<string, unknown>,
    raw: readonly unknown[],
  ): OpenApiParameter[] {
    const params: OpenApiParameter[] = [];
    for (const entry of raw) {
      const resolved = isObject(entry) ? deref(document, entry) : entry;
      if (!isObject(resolved)) {
        continue;
      }
      const location = resolved.in;
      if (
        location !== "path" &&
        location !== "query" &&
        location !== "header" &&
        location !== "cookie"
      ) {
        continue;
      }
      if (typeof resolved.name !== "string") {
        continue;
      }
      const schema = this.#resolveParameterSchema(document, resolved);
      params.push({
        name: resolved.name,
        location,
        required: resolved.required === true || location === "path",
        schema,
        description: typeof resolved.description === "string" ? resolved.description : undefined,
      });
    }
    return params;
  }

  #resolveRequestBody(
    document: Record<string, unknown>,
    raw: unknown,
    rawParameters: readonly unknown[] = [],
  ): OpenApiRequestBody | undefined {
    if (isObject(raw)) {
      const resolved = deref(document, raw);
      if (isObject(resolved) && isObject(resolved.content)) {
        const content = resolved.content;
        const contentType =
          "application/json" in content ? "application/json" : Object.keys(content)[0];
        if (contentType !== undefined) {
          const media = content[contentType];
          const schema =
            isObject(media) && isObject(media.schema)
              ? (derefSchema(document, media.schema) as Record<string, unknown>)
              : {};
          return {
            required: resolved.required === true,
            contentType,
            schema,
          };
        }
      }
    }
    return this.#resolveSwaggerBodyParameter(document, rawParameters);
  }

  #resolveParameterSchema(
    document: Record<string, unknown>,
    parameter: Record<string, unknown>,
  ): Record<string, unknown> {
    if (isObject(parameter.schema)) {
      return derefSchema(document, parameter.schema) as Record<string, unknown>;
    }

    const schema: Record<string, unknown> = {};
    for (const key of SWAGGER_PARAMETER_SCHEMA_KEYS) {
      if (parameter[key] !== undefined) {
        schema[key] = parameter[key];
      }
    }
    return derefSchema(document, schema) as Record<string, unknown>;
  }

  #resolveSwaggerBodyParameter(
    document: Record<string, unknown>,
    rawParameters: readonly unknown[],
  ): OpenApiRequestBody | undefined {
    for (const entry of rawParameters) {
      const resolved = isObject(entry) ? deref(document, entry) : entry;
      if (!isObject(resolved) || resolved.in !== "body") {
        continue;
      }
      const schema = isObject(resolved.schema)
        ? (derefSchema(document, resolved.schema) as Record<string, unknown>)
        : {};
      return {
        required: resolved.required === true,
        contentType: "application/json",
        schema,
      };
    }
    return undefined;
  }

  async #request(
    operation: OpenApiOperation,
    baseUrl: string,
    args: Record<string, unknown>,
  ): Promise<OpenApiToolResult> {
    const headers = await resolveHeaders(this.#connection);

    let path = operation.pathTemplate;
    const query = new URLSearchParams();
    const cookies: string[] = [];

    for (const param of operation.parameters) {
      const value = args[param.name];
      if (value === undefined || value === null) {
        continue;
      }
      if (param.location === "path") {
        path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      } else if (param.location === "query") {
        appendQuery(query, param.name, value);
      } else if (param.location === "cookie") {
        cookies.push(`${param.name}=${encodeURIComponent(String(value))}`);
      } else {
        headers[param.name] = String(value);
      }
    }

    applySecurity(operation.security, this.#connection, headers, query, cookies);

    if (cookies.length > 0) {
      const existing = headers.cookie ?? headers.Cookie;
      delete headers.Cookie;
      headers.cookie = [existing, ...cookies].filter((part) => Boolean(part)).join("; ");
    }

    const url = new URL(joinPath(baseUrl, path));
    url.search = query.toString();

    let body: string | undefined;
    if (operation.requestBody !== undefined && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers["content-type"] = operation.requestBody.contentType;
    }

    const response = await fetch(url, {
      method: operation.method.toUpperCase(),
      headers,
      body,
    });

    return {
      status: response.status,
      statusText: response.statusText,
      body: await readResponseBody(response),
    };
  }
}

function appendQuery(query: URLSearchParams, name: string, value: unknown): void {
  if (isArray(value)) {
    for (const item of value) {
      query.append(name, String(item));
    }
    return;
  }
  query.append(name, String(value));
}

function joinPath(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
