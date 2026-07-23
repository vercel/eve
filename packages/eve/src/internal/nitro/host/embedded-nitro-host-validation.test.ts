import type { Nitro } from "nitro/types";
import { describe, expect, it } from "vitest";

import {
  beginEmbeddedEveNitroInstallation,
  validateEmbeddedEveNitroHost,
  validateEmbeddedEveNitroRouteReplacement,
  type EmbeddedEveNitroRequirements,
} from "#internal/nitro/host/embedded-nitro-host-validation.js";

function createNitro(
  input: {
    builder?: string;
    dev?: boolean;
    handlers?: Array<{ handler: string; method?: string; route: string }>;
    majorVersion?: number;
    preset?: string;
    routes?: Nitro["options"]["routes"];
    serverEntry?: boolean;
    static?: boolean;
    virtual?: Record<string, string>;
  } = {},
): Nitro {
  return Object.assign({} as Nitro, {
    meta: {
      majorVersion: input.majorVersion ?? 3,
      version: `${input.majorVersion ?? 3}.0.0-test`,
    },
    options: {
      builder: input.builder ?? "vite",
      dev: input.dev ?? true,
      handlers: input.handlers ?? [],
      preset: input.preset ?? "nitro-dev",
      routes: input.routes ?? {},
      serverEntry: input.serverEntry ?? true,
      static: input.static ?? false,
      virtual: input.virtual ?? {},
    },
    scannedHandlers: [],
  });
}

function createRequirements(
  input: Partial<EmbeddedEveNitroRequirements> = {},
): EmbeddedEveNitroRequirements {
  return {
    routes: [
      {
        method: "GET",
        route: "/eve/v1/health",
        virtualId: "#eve-route-handler/GET /eve/v1/health",
      },
    ],
    schedules: false,
    websocket: false,
    ...input,
  };
}

describe("validateEmbeddedEveNitroHost", () => {
  it("accepts a dynamic Nitro 3 Vite host for HTTP-only eve resources", () => {
    expect(() => validateEmbeddedEveNitroHost(createNitro(), createRequirements())).not.toThrow();
  });

  it("accepts HTTP-only resources on an otherwise unknown dynamic Nitro 3 preset", () => {
    expect(() =>
      validateEmbeddedEveNitroHost(
        createNitro({ builder: "rolldown", dev: false, preset: "cloudflare-module" }),
        createRequirements(),
      ),
    ).not.toThrow();
  });

  it("rejects unsupported Nitro major versions before route mutation", () => {
    expect(() =>
      validateEmbeddedEveNitroHost(createNitro({ majorVersion: 4 }), createRequirements()),
    ).toThrowError(/Nitro 3.*received 4\.0\.0-test/);
  });

  it("reports a compatibility diagnostic when Nitro metadata is absent", () => {
    const nitro = createNitro();
    Reflect.deleteProperty(nitro, "meta");

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).toThrowError(
      /Nitro 3.*unknown Nitro version/,
    );
  });

  it.each([
    { label: "static output", options: { static: true } },
    { label: "no server entry", options: { serverEntry: false } },
  ])("rejects a host with $label", ({ options }) => {
    expect(() =>
      validateEmbeddedEveNitroHost(createNitro(options), createRequirements()),
    ).toThrowError(/dynamic server runtime/);
  });

  it.each([
    { requirements: { schedules: true }, resource: "schedules" },
    { requirements: { websocket: true }, resource: "WebSocket channels" },
  ])(
    "rejects $resource when the preset lacks executable parity evidence",
    ({ requirements, resource }) => {
      expect(() =>
        validateEmbeddedEveNitroHost(
          createNitro({ builder: "rolldown", dev: false, preset: "cloudflare-module" }),
          createRequirements(requirements),
        ),
      ).toThrowError(new RegExp(`${resource}.*node-server.*nitro-dev`, "i"));
    },
  );

  it("accepts schedules and WebSocket channels on the proven Node server preset", () => {
    expect(() =>
      validateEmbeddedEveNitroHost(
        createNitro({ builder: "rolldown", dev: false, preset: "node-server" }),
        createRequirements({ schedules: true, websocket: true }),
      ),
    ).not.toThrow();
  });

  it("reports an exact method and path collision", () => {
    const nitro = createNitro({
      handlers: [{ handler: "/host/health.ts", method: "GET", route: "/eve/v1/health" }],
    });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).toThrowError(
      /GET \/eve\/v1\/health.*host\/health\.ts/,
    );
  });

  it("treats an existing methodless handler as colliding with an eve method", () => {
    const nitro = createNitro({
      handlers: [{ handler: "/host/all.ts", route: "/eve/v1/health" }],
    });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).toThrowError(
      /GET \/eve\/v1\/health/,
    );
  });

  it("allows another method on the same exact path", () => {
    const nitro = createNitro({
      handlers: [{ handler: "/host/post.ts", method: "POST", route: "/eve/v1/health" }],
    });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).not.toThrow();
  });

  it.each([
    {
      label: "string handler",
      route: "/eve/v1/health",
      routes: { "/eve/v1/health": "/host/inline-health.ts" },
    },
    {
      label: "object handler with an overlapping method",
      route: "/eve/v1/health",
      routes: {
        "/eve/v1/health": { handler: "/host/inline-health.ts", method: "GET" as const },
      },
    },
  ])("rejects an inline Nitro route configured as a $label", ({ route, routes }) => {
    const nitro = createNitro({ routes });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).toThrowError(
      new RegExp(`GET ${route}.*host/inline-health\\.ts`),
    );
  });

  it("allows an inline Nitro route on the same path for a different method", () => {
    const nitro = createNitro({
      routes: {
        "/eve/v1/health": { handler: "/host/inline-health.ts", method: "POST" },
      },
    });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).not.toThrow();
  });

  it.each([
    ["plain", "/users/:id", "/users/:slug"],
    ["optional", "/users/:id?", "/users/:slug?"],
    ["constrained", String.raw`/users/:id(\d+)`, String.raw`/users/:slug(\d+)`],
    ["catch-all", "/users/**:path", "/users/**:rest"],
  ])(
    "treats %s dynamic parameter names as the same Nitro route shape",
    (_label, eveRoute, hostRoute) => {
      const nitro = createNitro({
        handlers: [{ handler: "/host/user.ts", method: "GET", route: hostRoute }],
      });
      const requirements = createRequirements({ routes: [{ method: "GET", route: eveRoute }] });

      expect(() => validateEmbeddedEveNitroHost(nitro, requirements)).toThrowError(
        /host\/user\.ts/,
      );
    },
  );

  it.each([
    ["different static routes", "/users/current", "/users/archive"],
    ["a static and dynamic route", "/users/:id", "/users/current"],
    ["a plain and constrained parameter", "/users/:id", String.raw`/users/:slug(\d+)`],
    ["parameters with different constraints", String.raw`/users/:id(\d+)`, "/users/:slug([a-z]+)"],
    ["a required and optional parameter", "/users/:id", "/users/:slug?"],
    ["a parameter and catch-all", "/users/:id", "/users/**:slug"],
  ])(
    "allows %s because Nitro gives the patterns distinct shapes",
    (_label, eveRoute, hostRoute) => {
      const nitro = createNitro({
        handlers: [{ handler: "/host/user.ts", method: "GET", route: hostRoute }],
      });
      const requirements = createRequirements({ routes: [{ method: "GET", route: eveRoute }] });

      expect(() => validateEmbeddedEveNitroHost(nitro, requirements)).not.toThrow();
    },
  );

  it("reports an exact virtual module collision", () => {
    const nitro = createNitro({
      virtual: { "#eve-route-handler/GET /eve/v1/health": "export default () => 'host'" },
    });

    expect(() => validateEmbeddedEveNitroHost(nitro, createRequirements())).toThrowError(
      /#eve-route-handler\/GET \/eve\/v1\/health/,
    );
  });
});

describe("beginEmbeddedEveNitroInstallation", () => {
  it("rejects a duplicate installation after commit", () => {
    const nitro = createNitro();
    beginEmbeddedEveNitroInstallation(nitro).commit();

    expect(() => beginEmbeddedEveNitroInstallation(nitro)).toThrowError(/already installed/i);
  });

  it("releases ownership when setup rolls back", () => {
    const nitro = createNitro();
    beginEmbeddedEveNitroInstallation(nitro).rollback();

    expect(() => beginEmbeddedEveNitroInstallation(nitro)).not.toThrow();
  });
});

describe("validateEmbeddedEveNitroRouteReplacement", () => {
  const previousResource = {
    method: "GET",
    route: "/eve-marker",
    virtualId: "#nitro/virtual/eve-channel/GET /eve-marker",
  } as const;
  const previous = [previousResource];

  it("permits replacement of the exact resources already owned by eve", () => {
    const nitro = createNitro({
      handlers: [
        {
          handler: previousResource.virtualId,
          method: previousResource.method,
          route: previousResource.route,
        },
      ],
      virtual: { [previousResource.virtualId]: "export default () => 'old'" },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, { next: previous, previous }),
    ).not.toThrow();
  });

  it("rejects a new channel route that collides with a host handler", () => {
    const nitro = createNitro({
      handlers: [
        {
          handler: previousResource.virtualId,
          method: previousResource.method,
          route: previousResource.route,
        },
        { handler: "/host/admin.ts", method: "POST", route: "/admin" },
      ],
      virtual: { [previousResource.virtualId]: "export default () => 'old'" },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [
          ...previous,
          {
            method: "POST",
            route: "/admin",
            virtualId: "#nitro/virtual/eve-channel/POST /admin",
          },
        ],
        previous,
      }),
    ).toThrowError(/POST \/admin.*host\/admin\.ts/);
  });

  it.each([
    {
      label: "methodless string handler",
      routes: { "/admin": "/host/inline-admin.ts" },
    },
    {
      label: "object handler with an overlapping method",
      routes: {
        "/admin": { handler: "/host/inline-admin.ts", method: "POST" as const },
      },
    },
  ])("rejects a live route replacement colliding with an inline $label", ({ routes }) => {
    const nitro = createNitro({ routes });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [{ method: "POST", route: "/admin" }],
        previous: [],
      }),
    ).toThrowError(/POST \/admin.*host\/inline-admin\.ts/);
  });

  it("allows a live route replacement when an inline route uses a different method", () => {
    const nitro = createNitro({
      routes: { "/admin": { handler: "/host/inline-admin.ts", method: "GET" } },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [{ method: "POST", route: "/admin" }],
        previous: [],
      }),
    ).not.toThrow();
  });

  it("rejects a live route replacement with an equivalent dynamic parameter name", () => {
    const nitro = createNitro({
      routes: {
        "/users/:slug": { handler: "/host/inline-user.ts", method: "GET" },
      },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [{ method: "GET", route: "/users/:id" }],
        previous: [],
      }),
    ).toThrowError(/GET \/users\/:id.*host\/inline-user\.ts/);
  });

  it.each([
    ["different static routes", "/users/current", "/users/archive"],
    ["a static and dynamic route", "/users/:id", "/users/current"],
    ["different constrained parameters", String.raw`/users/:id(\d+)`, "/users/:slug"],
    ["an optional parameter and a catch-all", "/users/:id?", "/users/**:slug"],
  ])("allows a live replacement with %s", (_label, eveRoute, hostRoute) => {
    const nitro = createNitro({
      routes: { [hostRoute]: { handler: "/host/inline-user.ts", method: "GET" } },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [{ method: "GET", route: eveRoute }],
        previous: [],
      }),
    ).not.toThrow();
  });

  it("rejects a new virtual module id already owned by the host", () => {
    const virtualId = "#nitro/virtual/eve-channel/POST /new";
    const nitro = createNitro({
      handlers: [
        {
          handler: previousResource.virtualId,
          method: previousResource.method,
          route: previousResource.route,
        },
      ],
      virtual: {
        [previousResource.virtualId]: "export default () => 'old'",
        [virtualId]: "export default () => 'host'",
      },
    });

    expect(() =>
      validateEmbeddedEveNitroRouteReplacement(nitro, {
        next: [...previous, { method: "POST", route: "/new", virtualId }],
        previous,
      }),
    ).toThrowError(new RegExp(virtualId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
