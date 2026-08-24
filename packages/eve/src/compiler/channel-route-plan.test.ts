import { describe, expect, it } from "vitest";

import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import {
  CHANNEL_CORS_CONFLICT_DIAGNOSTIC_CODE,
  CHANNEL_PREFLIGHT_COLLISION_DIAGNOSTIC_CODE,
  CHANNEL_ROUTE_DUPLICATE_DIAGNOSTIC_CODE,
  CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE,
  CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE,
  CHANNEL_WEBSOCKET_GET_COLLISION_DIAGNOSTIC_CODE,
  createCompiledChannelRoutePlan as createCompiledChannelRoutePlanForNode,
  RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE,
  validateCompiledChannelRoutePlan,
} from "#compiler/channel-route-plan.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import { getHostRouteReservations } from "#protocol/host-route-inventory.js";
import { eveRoutePatternsOverlap } from "#protocol/route-pattern.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";

function createCompiledChannelRoutePlan(
  input: Omit<Parameters<typeof createCompiledChannelRoutePlanForNode>[0], "nodeId">,
) {
  return createCompiledChannelRoutePlanForNode({
    ...input,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
  });
}

const cors = { origin: ["https://example.com"] } as const;

function route(
  sourceId: string,
  method: CompiledChannelDefinition["method"],
  urlPath: string,
  options: { readonly cors?: NormalizedChannelCorsOptions } = {},
): CompiledChannelDefinition {
  return {
    cors: options.cors,
    kind: "channel",
    logicalPath: `channels/${sourceId}.ts`,
    method,
    name: sourceId,
    sourceId,
    sourceKind: "module",
    urlPath,
  };
}

function bindings(...sourceIds: string[]): Record<string, CompiledModuleBinding> {
  return Object.fromEntries(
    sourceIds.map((sourceId) => [
      sourceId,
      {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `/app/agent/channels/${sourceId}.ts`,
        },
        logicalPath: `channels/${sourceId}.ts`,
        owner: { kind: "application" },
      },
    ]),
  );
}

describe("createCompiledChannelRoutePlan", () => {
  it("selects different-source route collisions once and retains loser provenance", () => {
    const diagnostics: Parameters<typeof createCompiledChannelRoutePlan>[0]["diagnostics"] = [];
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("first", "second"),
      diagnostics,
      routes: [route("first", "GET", "/users/:id"), route("second", "GET", "/users/:name")],
    });

    expect(plan.effective.map((entry) => entry.sourceId)).toEqual(["first"]);
    expect(plan.shadowed).toEqual([
      expect.objectContaining({
        loser: expect.objectContaining({
          binding: expect.objectContaining({ logicalPath: "channels/second.ts" }),
          route: expect.objectContaining({ sourceId: "second" }),
        }),
        method: "GET",
        pathPattern: "/users/:_",
        winningSourceId: "first",
      }),
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE,
        severity: "warning",
        sourceId: "second",
      }),
    ]);
  });

  it("rejects a parameter-name-equivalent duplicate from one source", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("same"),
        diagnostics: [],
        routes: [route("same", "GET", "/users/:id"), route("same", "GET", "/users/:name")],
      }),
    ).toThrow(CHANNEL_ROUTE_DUPLICATE_DIAGNOSTIC_CODE);
  });

  it("rejects a same-source duplicate even when another source won first", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("winner", "same"),
        diagnostics: [],
        routes: [
          route("winner", "GET", "/users/:id"),
          route("same", "GET", "/users/:name"),
          route("same", "GET", "/users/:userId"),
        ],
      }),
    ).toThrow(CHANNEL_ROUTE_DUPLICATE_DIAGNOSTIC_CODE);
  });

  it("canonicalizes trailing slashes before selecting route identities and CORS", () => {
    const diagnostics: Parameters<typeof createCompiledChannelRoutePlan>[0]["diagnostics"] = [];
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("first", "second", "post"),
      diagnostics,
      routes: [
        route("first", "GET", "/hooks/", { cors }),
        route("second", "GET", "/hooks", { cors }),
        route("post", "POST", "/hooks/", { cors }),
      ],
    });

    expect(plan.effective.map((entry) => `${entry.method} ${entry.urlPath}`)).toEqual([
      "GET /hooks",
      "POST /hooks",
    ]);
    expect(plan.preflight).toEqual([{ cors, pathPattern: "/hooks", sourceIds: ["first", "post"] }]);
    expect(plan.shadowed).toEqual([
      expect.objectContaining({ pathPattern: "/hooks", winningSourceId: "first" }),
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE }),
    ]);
  });

  it.each([
    "relative",
    "/users//messages",
    "/users/:",
    "/users/:id?",
    "/users/:id+",
    "/users/:id*",
    "/users/:id(\\d+)",
    "/files/*",
    "/files/**",
    "/prefix:id",
    "/{optional}",
  ])("rejects unsupported route pattern %s with a stable diagnostic", (urlPath) => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("invalid"),
        diagnostics: [],
        routes: [route("invalid", "GET", urlPath)],
      }),
    ).toThrow(CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE);
  });

  it.each(getHostRouteReservations())(
    "rejects reserved host collision $method $pathPattern",
    ({ method, pathPattern }) => {
      const channelMethod = method === "ALL" ? "GET" : method;
      expect(() =>
        createCompiledChannelRoutePlan({
          bindings: bindings("reserved"),
          diagnostics: [],
          routes: [route("reserved", channelMethod, pathPattern)],
        }),
      ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
    },
  );

  it("rejects a concrete path inside a reserved host parameter pattern", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("reserved"),
        diagnostics: [],
        routes: [route("reserved", "POST", "/eve/v1/dev/schedules/nightly")],
      }),
    ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
  });

  it("rejects a concrete production cron capability path", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("reserved"),
        diagnostics: [],
        routes: [route("reserved", "POST", "/eve/v1/cron/build-secret")],
      }),
    ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "WEBSOCKET"] as const)(
    "rejects %s at the reserved workflow ALL route",
    (method) => {
      expect(() =>
        createCompiledChannelRoutePlan({
          bindings: bindings("workflow"),
          diagnostics: [],
          routes: [route("workflow", method, "/.well-known/workflow/v1/flow")],
        }),
      ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
    },
  );

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "WEBSOCKET"] as const)(
    "rejects %s inside the reserved production cron ALL match space",
    (method) => {
      expect(() =>
        createCompiledChannelRoutePlan({
          bindings: bindings("cron"),
          diagnostics: [],
          routes: [route("cron", method, "/eve/v1/cron/build-secret")],
        }),
      ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
    },
  );

  it("treats WebSocket routes as GET when checking reserved host routes", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("socket"),
        diagnostics: [],
        routes: [route("socket", "WEBSOCKET", "/eve/v1/dev/runtime-artifacts")],
      }),
    ).toThrow(RESERVED_ROUTE_COLLISION_DIAGNOSTIC_CODE);
  });

  it.each([
    ["/socket/:room", "/socket/current"],
    ["/socket/current", "/socket/:room"],
    ["/socket/:room", "/socket/:id"],
  ])("rejects overlapping WebSocket and GET routes (%s, %s)", (socketPath, getPath) => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("socket", "get"),
        diagnostics: [],
        routes: [route("socket", "WEBSOCKET", socketPath), route("get", "GET", getPath)],
      }),
    ).toThrow(CHANNEL_WEBSOCKET_GET_COLLISION_DIAGNOSTIC_CODE);
  });

  it("allows WebSocket and non-GET HTTP methods at one pattern", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("socket", "post"),
      diagnostics: [],
      routes: [route("socket", "WEBSOCKET", "/socket/:room"), route("post", "POST", "/socket/:id")],
    });

    expect(plan.effective).toHaveLength(2);
  });

  it("derives one preflight from identical selected CORS routes and ignores WebSocket", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("get", "post", "socket"),
      diagnostics: [],
      routes: [
        route("get", "GET", "/hooks/:id", { cors }),
        route("post", "POST", "/hooks/:name", { cors }),
        route("socket", "WEBSOCKET", "/socket/:socket", { cors }),
      ],
    });

    expect(plan.preflight).toEqual([
      { cors, pathPattern: "/hooks/:id", sourceIds: ["get", "post"] },
    ]);
  });

  it("records one preflight cause when one source owns multiple CORS methods", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("hooks"),
      diagnostics: [],
      routes: [
        route("hooks", "GET", "/hooks/:id", { cors }),
        route("hooks", "POST", "/hooks/:name", { cors }),
      ],
    });

    expect(plan.preflight).toEqual([{ cors, pathPattern: "/hooks/:id", sourceIds: ["hooks"] }]);
    expect(validateCompiledChannelRoutePlan(plan, bindings("hooks"))).toEqual([]);
  });

  it("rejects explicit OPTIONS and generated preflight at one pattern", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("get", "options"),
        diagnostics: [],
        routes: [
          route("get", "GET", "/hooks/:id", { cors }),
          route("options", "OPTIONS", "/hooks/:name"),
        ],
      }),
    ).toThrow(CHANNEL_PREFLIGHT_COLLISION_DIAGNOSTIC_CODE);
  });

  it.each([
    ["/hooks/:id", "/hooks/current"],
    ["/hooks/current", "/hooks/:id"],
  ])(
    "rejects explicit OPTIONS and generated preflight across overlapping patterns (%s, %s)",
    (corsPath, optionsPath) => {
      expect(() =>
        createCompiledChannelRoutePlan({
          bindings: bindings("get", "options"),
          diagnostics: [],
          routes: [
            route("get", "GET", corsPath, { cors }),
            route("options", "OPTIONS", optionsPath),
          ],
        }),
      ).toThrow(CHANNEL_PREFLIGHT_COLLISION_DIAGNOSTIC_CODE);
    },
  );

  it("rejects conflicting CORS options at one pattern", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("get", "post"),
        diagnostics: [],
        routes: [
          route("get", "GET", "/hooks", { cors }),
          route("post", "POST", "/hooks", { cors: { origin: ["https://other.example"] } }),
        ],
      }),
    ).toThrow(CHANNEL_CORS_CONFLICT_DIAGNOSTIC_CODE);
  });

  it("rejects conflicting CORS options across parameter and static overlaps", () => {
    expect(() =>
      createCompiledChannelRoutePlan({
        bindings: bindings("get", "post"),
        diagnostics: [],
        routes: [
          route("get", "GET", "/hooks/:id", { cors }),
          route("post", "POST", "/hooks/current", {
            cors: { origin: ["https://other.example"] },
          }),
        ],
      }),
    ).toThrow(CHANNEL_CORS_CONFLICT_DIAGNOSTIC_CODE);
  });

  it("retains distinct overlapping preflight patterns when normalized CORS agrees", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("get", "post"),
      diagnostics: [],
      routes: [
        route("get", "GET", "/hooks/:id", { cors }),
        route("post", "POST", "/hooks/current", { cors }),
      ],
    });

    expect(plan.preflight).toEqual([
      { cors, pathPattern: "/hooks/:id", sourceIds: ["get"] },
      { cors, pathPattern: "/hooks/current", sourceIds: ["post"] },
    ]);
    expect(validateCompiledChannelRoutePlan(plan, bindings("get", "post"))).toEqual([]);
  });
});

describe("compiled route-plan invariants", () => {
  it("matches static paths inside parameter patterns", () => {
    expect(
      eveRoutePatternsOverlap("/eve/v1/dev/schedules/nightly", "/eve/v1/dev/schedules/:scheduleId"),
    ).toBe(true);
  });

  it("rejects unsupported patterns and non-canonical trailing slashes in loaded plans", () => {
    const selectedBindings = bindings("get");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [route("get", "GET", "/hooks")],
    });

    expect(
      validateCompiledChannelRoutePlan(
        { ...plan, effective: [{ ...plan.effective[0]!, urlPath: "/hooks/*" }] },
        selectedBindings,
      ),
    ).toContainEqual(expect.stringContaining(CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE));
    expect(
      validateCompiledChannelRoutePlan(
        { ...plan, effective: [{ ...plan.effective[0]!, urlPath: "/hooks/" }] },
        selectedBindings,
      ),
    ).toContain('channelRoutes.effective route "GET /hooks/" is not canonical; expected "/hooks".');
  });

  it("rejects unsupported methods in constructed route plans", () => {
    const malformedRoute = route("trace", "GET", "/hooks");
    Object.defineProperty(malformedRoute, "method", { value: "TRACE" });

    expect(
      validateCompiledChannelRoutePlan(
        { effective: [malformedRoute], preflight: [], shadowed: [] },
        bindings("trace"),
      ),
    ).toContain('channelRoutes.effective route "TRACE /hooks" has an unsupported method.');
  });

  it("rejects loaded plans with overlapping WebSocket and GET routes", () => {
    const selectedBindings = bindings("socket", "get");
    const issues = validateCompiledChannelRoutePlan(
      {
        effective: [
          route("socket", "WEBSOCKET", "/socket/:room"),
          route("get", "GET", "/socket/current"),
        ],
        preflight: [],
        shadowed: [],
      },
      selectedBindings,
    );

    expect(issues).toContain(
      'channelRoutes.effective routes "WEBSOCKET /socket/:room" and "GET /socket/current" overlap on the WebSocket GET transport.',
    );
  });

  it("rejects loaded plans with conflicting CORS over parameter and static overlaps", () => {
    const selectedBindings = bindings("get", "post");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [
        route("get", "GET", "/hooks/:id", { cors }),
        route("post", "POST", "/hooks/current", { cors }),
      ],
    });
    const issues = validateCompiledChannelRoutePlan(
      {
        ...plan,
        effective: [
          plan.effective[0]!,
          {
            ...plan.effective[1]!,
            cors: { origin: ["https://other.example"] },
          },
        ],
      },
      selectedBindings,
    );

    expect(issues).toContain(
      'channelRoutes.effective routes "GET /hooks/:id" and "POST /hooks/current" have conflicting CORS options over an overlapping match space.',
    );
  });

  it("rejects loaded plans with explicit OPTIONS inside a generated preflight match space", () => {
    const selectedBindings = bindings("get", "options");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [
        route("get", "GET", "/hooks/:id", { cors }),
        route("options", "GET", "/hooks/current"),
      ],
    });
    const issues = validateCompiledChannelRoutePlan(
      {
        ...plan,
        effective: [plan.effective[0]!, { ...plan.effective[1]!, method: "OPTIONS" }],
      },
      selectedBindings,
    );

    expect(issues).toContain(
      'channelRoutes.effective routes "GET /hooks/:id" and "OPTIONS /hooks/current" overlap between explicit OPTIONS and a CORS preflight cause.',
    );
    expect(issues).toContain(
      'channelRoutes.preflight at "/hooks/:id" overlaps an explicit OPTIONS route.',
    );
  });

  it("rejects dangling preflight causes in loaded artifacts", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("get"),
      diagnostics: [],
      routes: [route("get", "GET", "/hooks", { cors })],
    });
    const malformed = {
      ...plan,
      preflight: [{ ...plan.preflight[0]!, sourceIds: ["missing"] }],
    };

    expect(validateCompiledChannelRoutePlan(malformed, bindings("get"))).toContain(
      'channelRoutes.preflight at "/hooks" has dangling causes.',
    );
  });

  it("requires the exact selected CORS source set in loaded preflight records", () => {
    const selectedBindings = bindings("get", "post");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [
        route("get", "GET", "/hooks/:id", { cors }),
        route("post", "POST", "/hooks/:name", { cors }),
      ],
    });

    expect(
      validateCompiledChannelRoutePlan(
        {
          ...plan,
          preflight: [{ ...plan.preflight[0]!, sourceIds: ["get"] }],
        },
        selectedBindings,
      ),
    ).toContain('channelRoutes.preflight at "/hooks/:id" has dangling causes.');
  });

  it("rejects a loaded artifact that omits a required preflight", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("get"),
      diagnostics: [],
      routes: [route("get", "GET", "/hooks", { cors })],
    });

    expect(validateCompiledChannelRoutePlan({ ...plan, preflight: [] }, bindings("get"))).toContain(
      'channelRoutes.preflight is missing required pattern "/hooks".',
    );
  });

  it("rejects duplicate preflight patterns in loaded artifacts", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("get"),
      diagnostics: [],
      routes: [route("get", "GET", "/hooks/:id", { cors })],
    });

    expect(
      validateCompiledChannelRoutePlan(
        { ...plan, preflight: [plan.preflight[0]!, plan.preflight[0]!] },
        bindings("get"),
      ),
    ).toContain('channelRoutes.preflight contains duplicate pattern "/hooks/:_".');
  });

  it("rejects a shadowed route whose loser source is not selected", () => {
    const plan = createCompiledChannelRoutePlan({
      bindings: bindings("first", "second"),
      diagnostics: [],
      routes: [route("first", "GET", "/users/:id"), route("second", "GET", "/users/:name")],
    });

    expect(validateCompiledChannelRoutePlan(plan, bindings("first"))).toContain(
      'channelRoutes.shadowed references unbound loser source "second".',
    );
  });

  it("rejects a shadowed route whose retained binding disagrees with the selected binding", () => {
    const selectedBindings = bindings("first", "second");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [route("first", "GET", "/users/:id"), route("second", "GET", "/users/:name")],
    });
    const malformed = {
      ...plan,
      shadowed: [
        {
          ...plan.shadowed[0]!,
          loser: {
            ...plan.shadowed[0]!.loser,
            binding: {
              ...plan.shadowed[0]!.loser.binding,
              owner: { feature: "fabricated", kind: "framework" as const },
            },
          },
        },
      ],
    };

    expect(validateCompiledChannelRoutePlan(malformed, selectedBindings)).toContain(
      'channelRoutes.shadowed loser "second" does not match its selected binding.',
    );
  });

  it("rejects duplicate shadow records for one loser identity", () => {
    const selectedBindings = bindings("first", "second");
    const plan = createCompiledChannelRoutePlan({
      bindings: selectedBindings,
      diagnostics: [],
      routes: [route("first", "GET", "/users/:id"), route("second", "GET", "/users/:name")],
    });

    expect(
      validateCompiledChannelRoutePlan(
        { ...plan, shadowed: [plan.shadowed[0]!, plan.shadowed[0]!] },
        selectedBindings,
      ),
    ).toContain('channelRoutes.shadowed contains duplicate loser identity "second GET /users/:_".');
  });
});
