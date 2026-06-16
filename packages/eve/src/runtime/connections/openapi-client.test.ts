import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";

const SPEC: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/v1/projects/{id}": {
      get: {
        operationId: "getProject",
        summary: "Read a project",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "teamId", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/v1/projects": {
      post: {
        operationId: "createProject",
        summary: "Create a project",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewProject" },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/v1/health": {
      get: {
        summary: "Health check",
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      NewProject: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
};

const SWAGGER_SPEC: Record<string, unknown> = {
  swagger: "2.0",
  info: { title: "Swagger API", version: "1.0.0" },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  paths: {
    "/items/{id}": {
      get: {
        operationId: "getItem",
        summary: "Read an item",
        parameters: [
          { name: "id", in: "path", required: true, type: "string" },
          { name: "includeDetails", in: "query", type: "boolean" },
          { name: "tags", in: "query", type: "array", items: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items": {
      post: {
        operationId: "createSwaggerItem",
        parameters: [
          {
            name: "item",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/NewItem" },
          },
        ],
        responses: { "201": { description: "created" } },
      },
    },
  },
  definitions: {
    NewItem: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
};

function makeConnection(
  overrides: Partial<ResolvedConnectionDefinition> = {},
): ResolvedConnectionDefinition {
  return {
    connectionName: "test",
    description: "test connection",
    logicalPath: "connections/test.ts",
    protocol: "openapi",
    sourceId: "connections/test",
    sourceKind: "module",
    spec: SPEC,
    url: "https://api.example.com",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenApiConnectionClient", () => {
  it("maps operations to tools keyed on operationId", async () => {
    const client = new OpenApiConnectionClient(makeConnection());
    const metadata = await client.getToolMetadata();
    const names = metadata.map((m) => m.name).sort();

    expect(names).toContain("getProject");
    expect(names).toContain("createProject");
    // Operation without an operationId gets a synthesized name.
    expect(names).toContain("get_v1_health");
  });

  it("builds an input schema from path and query parameters", async () => {
    const client = new OpenApiConnectionClient(makeConnection());
    const metadata = await client.getToolMetadata();
    const getProject = metadata.find((m) => m.name === "getProject");

    expect(getProject?.inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, teamId: { type: "string" } },
      required: ["id"],
    });
  });

  it("builds input schemas from Swagger 2.0 top-level parameters", async () => {
    const client = new OpenApiConnectionClient(makeConnection({ spec: SWAGGER_SPEC, url: "" }));
    const metadata = await client.getToolMetadata();
    const getItem = metadata.find((m) => m.name === "getItem");

    expect(getItem?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        includeDetails: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    });
  });

  it("dereferences a $ref request body under the body property", async () => {
    const client = new OpenApiConnectionClient(makeConnection());
    const metadata = await client.getToolMetadata();
    const createProject = metadata.find((m) => m.name === "createProject");

    expect(createProject?.inputSchema).toMatchObject({
      properties: {
        body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      required: ["body"],
    });
  });

  it("dereferences Swagger 2.0 body parameters under the body property", async () => {
    const client = new OpenApiConnectionClient(makeConnection({ spec: SWAGGER_SPEC, url: "" }));
    const metadata = await client.getToolMetadata();
    const createItem = metadata.find((m) => m.name === "createSwaggerItem");

    expect(createItem?.inputSchema).toMatchObject({
      properties: {
        body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      required: ["body"],
    });
  });

  it("down-converts OpenAPI 3.0 nullable to draft 2020-12", async () => {
    const nullableSpec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Nullable API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string", nullable: true },
                      tags: { type: ["string"], nullable: true },
                      status: { enum: ["a", "b"], nullable: true },
                      note: { nullable: true },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    };
    const client = new OpenApiConnectionClient(makeConnection({ spec: nullableSpec }));
    const metadata = await client.getToolMetadata();
    const createItem = metadata.find((m) => m.name === "createItem");

    expect(createItem?.inputSchema).toMatchObject({
      properties: {
        body: {
          properties: {
            name: { type: ["string", "null"] },
            tags: { type: ["string", "null"] },
            status: { enum: ["a", "b", null] },
          },
        },
      },
    });
    // `nullable` is not a draft 2020-12 keyword and must not survive anywhere.
    expect(JSON.stringify(createItem?.inputSchema)).not.toContain("nullable");
  });

  it("applies an operations allow filter", async () => {
    const client = new OpenApiConnectionClient(
      makeConnection({ tools: { allow: ["getProject"] } }),
    );
    const metadata = await client.getToolMetadata();

    expect(metadata.map((m) => m.name)).toEqual(["getProject"]);
  });

  it("substitutes path params, appends query, and attaches auth on execute", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) =>
        new Response(JSON.stringify({ id: "prj_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        authorization: {
          getToken: async () => ({ token: "secret" }),
          principalType: "app",
        },
      }),
    );

    const result = await client.executeTool("getProject", { id: "prj_1", teamId: "team_9" });

    expect(result).toEqual({ status: 200, statusText: expect.any(String), body: { id: "prj_1" } });

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl.toString()).toBe("https://api.example.com/v1/projects/prj_1?teamId=team_9");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("serializes the request body on execute", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) => new Response(null, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection());
    const result = await client.executeTool("createProject", { body: { name: "demo" } });

    expect(result.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "demo" }));
  });

  it("returns non-2xx responses as structured results", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection());
    const result = await client.executeTool("getProject", { id: "missing" });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "nope" });
  });

  it("throws for an unknown tool name", async () => {
    const client = new OpenApiConnectionClient(makeConnection());
    await expect(client.executeTool("nonexistent", {})).rejects.toThrow(/not found/);
  });

  it("sanitizes operationIds into provider-legal tool names", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/a": {
          get: { operationId: "Pages.getPage", responses: { "200": { description: "ok" } } },
        },
        "/b": {
          get: {
            operationId: "weird name/with:chars",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const client = new OpenApiConnectionClient(makeConnection({ spec }));
    const names = (await client.getToolMetadata()).map((m) => m.name);

    expect(names).toContain("Pages_getPage");
    expect(names).toContain("weird_name_with_chars");
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("keeps deeply recursive schemas valid (no truncation of type/required/oneOf)", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { oneOf: [{ type: "string" }, { type: "number" }] },
              value: { type: ["string", "null"] },
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    };
    const client = new OpenApiConnectionClient(makeConnection({ spec }));
    const createNode = (await client.getToolMetadata()).find((m) => m.name === "createNode");
    expect(createNode).toBeDefined();
    const inputSchema = createNode!.inputSchema as {
      properties: { body: Record<string, unknown> };
    };
    const body = inputSchema.properties.body;

    expect(body).toMatchObject({
      type: "object",
      required: ["kind"],
      properties: {
        kind: { oneOf: [{ type: "string" }, { type: "number" }] },
        value: { type: ["string", "null"] },
        children: { type: "array" },
      },
    });

    // Truncation must never corrupt array-valued keywords or scalar entries
    // at any depth — the bug that produced `oneOf: {}` / `required: [{}]`.
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      for (const key of ["oneOf", "anyOf", "allOf", "required"]) {
        if (key in obj) expect(Array.isArray(obj[key])).toBe(true);
      }
      if (Array.isArray(obj.required)) {
        for (const entry of obj.required) expect(typeof entry).toBe("string");
      }
      for (const value of Object.values(obj)) visit(value);
    };
    visit(inputSchema);
  });

  it("derives the base URL from the spec servers when baseUrl is omitted", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "prj_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ url: "" }));
    await client.executeTool("getProject", { id: "prj_1" });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://api.example.com/v1/projects/prj_1");
  });

  it("derives the base URL from Swagger 2.0 schemes, host, and basePath", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) =>
        new Response(JSON.stringify({ id: "itm_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ spec: SWAGGER_SPEC, url: "" }));
    await client.executeTool("getItem", {
      id: "itm_1",
      includeDetails: true,
      tags: ["alpha", "beta"],
    });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe(
      "https://api.example.com/v1/items/itm_1?includeDetails=true&tags=alpha&tags=beta",
    );
  });

  it("lets an explicit baseUrl override the spec servers", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({ url: "https://override.example.com" }),
    );
    await client.executeTool("getProject", { id: "prj_1" });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://override.example.com/v1/projects/prj_1");
  });

  it("substitutes server variables when deriving the base URL", async () => {
    const spec: Record<string, unknown> = {
      ...SPEC,
      servers: [
        {
          url: "https://{tenant}.example.com",
          variables: { tenant: { default: "api" } },
        },
      ],
    };
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ spec, url: "" }));
    await client.executeTool("getProject", { id: "prj_1" });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://api.example.com/v1/projects/prj_1");
  });

  it("resolves a relative server URL against the spec URL", async () => {
    const doc: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "/api/v3" }],
      paths: {
        "/pets/{id}": {
          get: {
            operationId: "getPet",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const specUrl = "https://petstore.example.com/openapi.json";
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === specUrl) {
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ spec: specUrl, url: "" }));
    await client.executeTool("getPet", { id: "p1" });

    const requestCall = fetchMock.mock.calls.find((call) => String(call[0]) !== specUrl);
    expect(requestCall).toBeDefined();
    expect(String(requestCall![0])).toBe("https://petstore.example.com/api/v3/pets/p1");
  });

  it("throws when neither baseUrl nor a usable servers entry is present", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/health": {
          get: { operationId: "getHealth", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const client = new OpenApiConnectionClient(makeConnection({ spec, url: "" }));
    await expect(client.getToolMetadata()).rejects.toThrow(/no base URL/);
  });

  it("drops invalid JSON Schema type values from malformed specs", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/uptime": {
          get: {
            operationId: "getUptime",
            parameters: [
              { name: "start", in: "query", schema: { type: "PartialStartDate" } },
              { name: "mix", in: "query", schema: { type: ["string", "Bogus", "null"] } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const client = new OpenApiConnectionClient(makeConnection({ spec }));
    const getUptime = (await client.getToolMetadata()).find((m) => m.name === "getUptime");
    expect(getUptime).toBeDefined();
    const props = (
      getUptime!.inputSchema as { properties: Record<string, Record<string, unknown>> }
    ).properties;

    expect(props.start).not.toHaveProperty("type");
    expect(props.mix?.type).toEqual(["string", "null"]);
  });

  it("parses a YAML spec fetched from a URL", async () => {
    const yamlSpec = [
      "openapi: 3.0.3",
      "info:",
      "  title: YAML API",
      "  version: '1.0.0'",
      "servers:",
      "  - url: https://yaml.example.com",
      "paths:",
      "  /ping:",
      "    get:",
      "      operationId: ping",
      "      responses:",
      "        '200':",
      "          description: ok",
      "",
    ].join("\n");
    const specUrl = "https://yaml.example.com/openapi.yaml";
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === specUrl) {
        return new Response(yamlSpec, {
          status: 200,
          headers: { "content-type": "text/yaml" },
        });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ spec: specUrl, url: "" }));
    const names = (await client.getToolMetadata()).map((m) => m.name);

    expect(names).toContain("ping");
  });

  it("sends in: cookie parameters as a Cookie header", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/me": {
          get: {
            operationId: "getMe",
            parameters: [{ name: "session", in: "cookie", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(makeConnection({ spec }));
    await client.executeTool("getMe", { session: "abc 123" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).cookie).toBe("session=abc%20123");
  });

  it("places the credential in an apiKey header security scheme", async () => {
    const spec = securitySpec({ type: "apiKey", in: "header", name: "X-API-Key" });
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        spec,
        authorization: { getToken: async () => ({ token: "secret" }), principalType: "app" },
      }),
    );
    await client.executeTool("op", {});

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret");
    expect(headers.Authorization).toBeUndefined();
  });

  it("places the credential in an apiKey query security scheme", async () => {
    const spec = securitySpec({ type: "apiKey", in: "query", name: "api_key" });
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        spec,
        authorization: { getToken: async () => ({ token: "secret" }), principalType: "app" },
      }),
    );
    await client.executeTool("op", {});

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain("api_key=secret");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("uses HTTP basic auth when the security scheme is basic", async () => {
    const spec = securitySpec({ type: "http", scheme: "basic" });
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        spec,
        authorization: { getToken: async () => ({ token: "dXNlcjpwYXNz" }), principalType: "app" },
      }),
    );
    await client.executeTool("op", {});

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("places credentials from Swagger 2.0 securityDefinitions", async () => {
    const spec: Record<string, unknown> = {
      ...SWAGGER_SPEC,
      security: [{ appKey: [] }],
      securityDefinitions: { appKey: { type: "apiKey", in: "query", name: "app_key" } },
    };
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        spec,
        url: "",
        authorization: { getToken: async () => ({ token: "secret" }), principalType: "app" },
      }),
    );
    await client.executeTool("getItem", { id: "itm_1" });

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://api.example.com/v1/items/itm_1?app_key=secret");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("keeps Bearer auth for http bearer and oauth2 schemes", async () => {
    const spec = securitySpec({ type: "http", scheme: "bearer" });
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenApiConnectionClient(
      makeConnection({
        spec,
        authorization: { getToken: async () => ({ token: "secret" }), principalType: "app" },
      }),
    );
    await client.executeTool("op", {});

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });
});

/** Builds a minimal spec whose single operation requires `scheme`. */
function securitySpec(scheme: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "T", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    security: [{ schemeRef: [] }],
    paths: {
      "/op": {
        get: { operationId: "op", responses: { "200": { description: "ok" } } },
      },
    },
    components: { securitySchemes: { schemeRef: scheme } },
  };
}
