import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_CREATE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  type AuthFn,
  createIpAllowList,
  createUnauthorizedResponse,
  extractBearerToken,
  ForbiddenError,
  httpBasic,
  isIpAllowed,
  jwtHmac,
  localDev,
  none,
  placeholderAuth,
  routeAuth,
  UnauthenticatedError,
  vercelOidc,
  vercelSubject,
  verifyHttpBasic,
  verifyJwtEcdsa,
  verifyJwtHmac,
  verifyVercelOidc,
} from "#public/channels/auth.js";

const TEST_ROUTE_URL = `https://example.com${EVE_CREATE_SESSION_ROUTE_PATH}`;

describe("verifyHttpBasic", () => {
  it("returns ok with the authenticated principal when credentials match", () => {
    const result = verifyHttpBasic(
      `Basic ${Buffer.from("ops:top-secret", "utf8").toString("base64")}`,
      { username: "ops", password: "top-secret" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionAuth).toMatchObject({
        authenticator: "http-basic",
        principalId: "ops",
        principalType: "user",
      });
    }
  });

  it("rejects mismatched credentials", () => {
    const result = verifyHttpBasic(`Basic ${Buffer.from("ops:wrong", "utf8").toString("base64")}`, {
      username: "ops",
      password: "top-secret",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects requests with no authorization header", () => {
    const result = verifyHttpBasic(null, { username: "ops", password: "top-secret" });
    expect(result.ok).toBe(false);
  });

  it("rejects requests with a non-Basic scheme", () => {
    const result = verifyHttpBasic("Bearer some.jwt.token", {
      username: "ops",
      password: "top-secret",
    });
    expect(result.ok).toBe(false);
  });
});

describe("verifyJwtHmac", () => {
  const secret = "shared-secret";

  async function createToken(input: { issuer: string; subject: string; audience: string }) {
    return await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(input.audience)
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer(input.issuer)
      .setSubject(input.subject)
      .sign(Buffer.from(secret, "utf8"));
  }

  it("verifies a valid HMAC JWT and returns the authenticated principal", async () => {
    const token = await createToken({
      audience: "weather-agent",
      issuer: "https://internal.example",
      subject: "worker:cron",
    });

    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      audiences: ["weather-agent"],
      issuer: "https://internal.example",
      secret,
      subjects: ["worker:*"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionAuth).toMatchObject({
        authenticator: "jwt-hmac",
        subject: "worker:cron",
      });
    }
  });

  it("rejects when the subject matcher is not satisfied", async () => {
    const token = await createToken({
      audience: "weather-agent",
      issuer: "https://internal.example",
      subject: "intern:cron",
    });

    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      audiences: ["weather-agent"],
      issuer: "https://internal.example",
      secret,
      subjects: ["worker:*"],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects when the secret is wrong", async () => {
    const token = await createToken({
      audience: "weather-agent",
      issuer: "https://internal.example",
      subject: "worker:cron",
    });

    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      audiences: ["weather-agent"],
      issuer: "https://internal.example",
      secret: "wrong-secret",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects null or empty tokens without throwing", async () => {
    expect(
      await verifyJwtHmac(null, {
        algorithm: "HS256",
        audiences: ["weather-agent"],
        issuer: "https://internal.example",
        secret,
      }),
    ).toEqual({ ok: false });

    expect(
      await verifyJwtHmac("", {
        algorithm: "HS256",
        audiences: ["weather-agent"],
        issuer: "https://internal.example",
        secret,
      }),
    ).toEqual({ ok: false });
  });
});

describe("verifyJwtEcdsa", () => {
  it("verifies a valid ECDSA JWT and returns the authenticated principal", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setAudience("weather-agent")
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer("https://partner.example")
      .setSubject("partner-sync")
      .sign(privateKey);

    const result = await verifyJwtEcdsa(token, {
      algorithm: "ES256",
      audiences: ["weather-agent"],
      issuer: "https://partner.example",
      publicKey: await exportSPKI(publicKey),
      subjects: ["partner-sync"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionAuth).toMatchObject({
        authenticator: "jwt-ecdsa",
        subject: "partner-sync",
      });
    }
  });
});

describe("extractBearerToken", () => {
  it("extracts the value after the Bearer scheme", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("trims surrounding whitespace from the token", () => {
    expect(extractBearerToken("Bearer    abc.def.ghi   ")).toBe("abc.def.ghi");
  });

  it("returns null for missing or non-bearer headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("Basic abc=")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("createIpAllowList + isIpAllowed", () => {
  it("matches exact IPs and CIDR ranges", () => {
    const allowList = createIpAllowList(["127.0.0.1", "10.0.0.0/8"]);
    expect(isIpAllowed("127.0.0.1", allowList)).toBe(true);
    expect(isIpAllowed("10.1.2.3", allowList)).toBe(true);
    expect(isIpAllowed("192.168.1.1", allowList)).toBe(false);
  });

  it("returns false for null inputs", () => {
    const allowList = createIpAllowList(["127.0.0.1"]);
    expect(isIpAllowed(null, allowList)).toBe(false);
  });
});

describe("createUnauthorizedResponse", () => {
  it("emits a default 401 with no challenges", async () => {
    const response = createUnauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("www-authenticate")).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      code: "unauthorized",
      ok: false,
    });
  });

  it("emits a 403 when status is overridden", async () => {
    const response = createUnauthorizedResponse({ status: 403, message: "Nope." });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "forbidden",
      error: "Nope.",
      ok: false,
    });
  });

  it("renders every supplied challenge into a www-authenticate header", () => {
    const response = createUnauthorizedResponse({
      challenges: [
        { scheme: "Basic", parameters: { realm: "weather" } },
        { scheme: "Bearer", parameters: { error: 'need "token"' } },
      ],
    });

    expect(response.headers.get("www-authenticate")).toContain('Basic realm="weather"');
    expect(response.headers.get("www-authenticate")).toMatch(/Bearer error="need \\"token\\""/);
  });
});

describe("UnauthenticatedError", () => {
  it("carries a structured 401 auth response", async () => {
    const error = new UnauthenticatedError({ message: "Sign in." });

    expect(error.message).toBe("Sign in.");
    expect(error.response.status).toBe(401);
    await expect(error.response.json()).resolves.toEqual({
      code: "unauthorized",
      error: "Sign in.",
      ok: false,
    });
  });
});

describe("ForbiddenError", () => {
  it("carries a structured 403 auth response", async () => {
    const error = new ForbiddenError({ message: "Nope." });

    expect(error.message).toBe("Nope.");
    expect(error.response.status).toBe(403);
    await expect(error.response.json()).resolves.toEqual({
      code: "forbidden",
      error: "Nope.",
      ok: false,
    });
  });
});

describe("none", () => {
  it("returns an AuthFn that produces a synthetic anonymous principal", () => {
    const authFn = none<Request>();
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
    });
    expect(authFn(request)).toEqual({
      attributes: {},
      authenticator: "none",
      principalId: "anonymous",
      principalType: "anonymous",
    });
  });

  it("terminates a routeAuth walk so it accepts anonymously", async () => {
    const request = new Request(TEST_ROUTE_URL, { method: "POST" });
    const result = await routeAuth(request, [none()]);
    expect(result).toMatchObject({
      authenticator: "none",
      principalType: "anonymous",
    });
  });
});

describe("localDev", () => {
  // `localDev()` checks the request URL's hostname, not `process.env`.
  // The env-based check it used to perform was unsafe on non-Vercel
  // deployments (any host where `VERCEL` happens to be unset) and these
  // tests pin the correct behaviour: only requests addressed to a
  // loopback hostname authenticate, regardless of which platform the
  // process happens to be running on.
  function requestFor(url: string): Request {
    return new Request(url, { method: "POST" });
  }

  it("authenticates requests addressed to `localhost`", () => {
    const result = localDev()(requestFor("http://localhost:3000/eve/v1/info"));
    expect(result).toEqual({
      attributes: {},
      authenticator: "local-dev",
      principalId: "local-dev",
      principalType: "local-dev",
    });
  });

  it("authenticates requests addressed to `127.0.0.1`", () => {
    expect(localDev()(requestFor("http://127.0.0.1:3000/eve/v1/info"))).toMatchObject({
      principalType: "local-dev",
    });
  });

  it("authenticates any address in the `127.0.0.0/8` loopback range", () => {
    // Some dev setups bind to addresses other than `127.0.0.1` (e.g.
    // `127.0.0.2` for multi-instance scenarios). The whole `/8` block
    // is loopback per RFC 1122.
    expect(localDev()(requestFor("http://127.5.6.7:3000/"))).toMatchObject({
      principalType: "local-dev",
    });
  });

  it("authenticates requests addressed to the IPv6 loopback `::1`", () => {
    expect(localDev()(requestFor("http://[::1]:3000/"))).toMatchObject({
      principalType: "local-dev",
    });
  });

  it("authenticates any `*.localhost` subdomain per RFC 6761", () => {
    // RFC 6761 reserves the entire `.localhost` TLD for loopback;
    // dev setups that use subdomains (e.g. `agent.localhost`,
    // `web.localhost`) must still authenticate.
    expect(localDev()(requestFor("http://agent.localhost:3000/"))).toMatchObject({
      principalType: "local-dev",
    });
  });

  it("rejects requests addressed to a public hostname (returns null)", () => {
    // Critical security case: a deployment behind any non-Vercel
    // platform (Fly, Railway, self-hosted, etc.) must not authenticate
    // arbitrary public traffic just because `process.env.VERCEL` is
    // unset. The previous env-based implementation had this hole.
    expect(localDev()(requestFor("https://example.com/eve/v1/info"))).toBeNull();
    expect(localDev()(requestFor("https://myapp.fly.dev/eve/v1/info"))).toBeNull();
    expect(localDev()(requestFor("https://myapp.vercel.app/eve/v1/info"))).toBeNull();
  });

  it("rejects requests addressed to a private (non-loopback) IP", () => {
    // `192.168.x.x`, `10.x.x.x`, and other RFC 1918 ranges are LAN
    // addresses, not loopback. A request from another machine on the
    // dev network should not authenticate via `localDev`.
    expect(localDev()(requestFor("http://192.168.1.5:3000/"))).toBeNull();
    expect(localDev()(requestFor("http://10.0.0.5:3000/"))).toBeNull();
  });

  it("rejects requests addressed to `0.0.0.0`", () => {
    // `0.0.0.0` is the "all interfaces" sentinel, not a loopback
    // address. A request claiming `0.0.0.0` as its host could
    // originate anywhere and is intentionally excluded.
    expect(localDev()(requestFor("http://0.0.0.0:3000/"))).toBeNull();
  });

  it("ignores `process.env.VERCEL` and `VERCEL_ENV` entirely", () => {
    // The host check is the only signal. Setting any combination of
    // Vercel env vars must not change the decision for a given URL —
    // this guards against regressions back to env-sniffing.
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      expect(localDev()(requestFor("http://localhost:3000/"))).toMatchObject({
        principalType: "local-dev",
      });
      expect(localDev()(requestFor("https://example.com/"))).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("routeAuth", () => {
  const SAMPLE_CONTEXT: SessionAuthContext = {
    attributes: {},
    authenticator: "test",
    principalId: "user-1",
    principalType: "user",
  };

  function makeRequest(): Request {
    return new Request(TEST_ROUTE_URL, { method: "POST" });
  }

  it("accepts on the first AuthFn that returns a SessionAuthContext", async () => {
    const calls: string[] = [];
    const accept: AuthFn<Request> = () => {
      calls.push("accept");
      return SAMPLE_CONTEXT;
    };
    const never: AuthFn<Request> = () => {
      calls.push("never");
      return null;
    };

    const result = await routeAuth(makeRequest(), [accept, never]);

    expect(result).toEqual(SAMPLE_CONTEXT);
    expect(calls).toEqual(["accept"]); // walk halted before the second fn
  });

  it("skips entries that return null or undefined and tries the next", async () => {
    const order: string[] = [];
    const a: AuthFn<Request> = () => {
      order.push("a");
      return null;
    };
    const b: AuthFn<Request> = () => {
      order.push("b");
      return undefined;
    };
    const c: AuthFn<Request> = () => {
      order.push("c");
      return SAMPLE_CONTEXT;
    };

    const result = await routeAuth(makeRequest(), [a, b, c]);

    expect(result).toEqual(SAMPLE_CONTEXT);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns a forbidden error response immediately and stops the walk", async () => {
    const never = vi.fn(() => SAMPLE_CONTEXT);

    const result = await routeAuth(makeRequest(), [
      () => {
        throw new ForbiddenError({ message: "custom auth rejection" });
      },
      never,
    ]);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(403);
      await expect(result.json()).resolves.toEqual({
        code: "forbidden",
        error: "custom auth rejection",
        ok: false,
      });
    }
    expect(never).not.toHaveBeenCalled();
  });

  it("recognizes response-carrying auth errors from another bundle instance", async () => {
    const response = createUnauthorizedResponse({ message: "Sign in." });
    const error = Object.assign(new Error("Sign in."), {
      name: "OtherBundleAuthError",
      response,
    });

    const result = await routeAuth(makeRequest(), () => {
      throw error;
    });

    expect(result).toBe(response);
  });

  it("propagates untagged AuthFn errors through the channel failure path", async () => {
    const error = new Error("auth lookup failed");

    await expect(
      routeAuth(makeRequest(), () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("returns a 401 Response when the walk exhausts with no winner", async () => {
    const result = await routeAuth(makeRequest(), [() => null, () => undefined]);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("returns a 401 Response for the empty-array case", async () => {
    const result = await routeAuth(makeRequest(), []);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
    }
  });

  it("accepts a single AuthFn (not in an array) for ergonomic single-policy routes", async () => {
    const result = await routeAuth(makeRequest(), () => SAMPLE_CONTEXT);

    expect(result).toEqual(SAMPLE_CONTEXT);
  });

  it("awaits async AuthFn entries", async () => {
    const asyncAccept: AuthFn<Request> = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return SAMPLE_CONTEXT;
    };

    const result = await routeAuth(makeRequest(), [asyncAccept]);

    expect(result).toEqual(SAMPLE_CONTEXT);
  });
});

describe("placeholderAuth", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it("skips the auth walk outside production", async () => {
    process.env.VERCEL_ENV = "preview";

    const result = await placeholderAuth()(new Request(TEST_ROUTE_URL));

    expect(result).toBeNull();
  });

  it("throws a structured auth rejection in production", async () => {
    process.env.VERCEL_ENV = "production";

    expect(() => placeholderAuth()(new Request(TEST_ROUTE_URL))).toThrow(UnauthenticatedError);
  });

  it("routes the production placeholder as a structured 401", async () => {
    process.env.VERCEL_ENV = "production";

    const result = await routeAuth(new Request(TEST_ROUTE_URL), placeholderAuth());

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
      expect(result.headers.get("cache-control")).toBe("no-store");
      await expect(result.json()).resolves.toEqual({
        code: "eve_production_auth_not_configured",
        error:
          "Production auth is not configured. Replace placeholderAuth() in agent/channels/eve.ts with your app's auth provider.",
        ok: false,
      });
    }
  });
});

describe("verifyVercelOidc", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects null and empty tokens without throwing", async () => {
    await expect(verifyVercelOidc(null)).resolves.toEqual({ ok: false });
    await expect(verifyVercelOidc("")).resolves.toEqual({ ok: false });
  });

  it("rejects tokens that fail to decode", async () => {
    await expect(verifyVercelOidc("not.a.real.jwt")).resolves.toEqual({ ok: false });
  });

  it("rejects tokens whose issuer is not on the Vercel OIDC prefix", async () => {
    // The token decodes successfully but its `iss` claim points at an
    // attacker-controlled host, which the prefix check rejects before
    // any JWKS lookup happens.
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setAudience("https://vercel.com/acme")
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer("https://attacker.example/oidc")
      .setSubject("acme")
      .sign(privateKey);

    await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
  });

  it("rejects tokens with no audience claim", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer("https://oidc.vercel.com/acme")
      .setSubject("acme")
      .sign(privateKey);

    await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
  });

  it("emits debug logs on the auth.vercel-oidc namespace for rejection paths", async () => {
    // The framework writes debug rejection logs through `console.log` so
    // operators tailing function logs can correlate failed auth attempts
    // back to a specific reason. Debug is opt-in (default level is `info`),
    // so an operator turns it on with EVE_LOG_LEVEL=debug.
    vi.stubEnv("EVE_LOG_LEVEL", "debug");
    const debugSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      // A missing token is the expected unauthenticated case (loopback dev,
      // anonymous probes) so it rejects silently; only malformed bearer
      // tokens — which signal a real misconfiguration — are logged.
      await verifyVercelOidc(null);
      await verifyVercelOidc("not.a.real.jwt");

      const lines = debugSpy.mock.calls.map((args) => String(args[0]));
      expect(lines).toContain(
        "[eve:auth.vercel-oidc] Rejected token that failed to decode as a JWT.",
      );
    } finally {
      debugSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  // ---------------------------------------------------------------------------
  // Default current-project bind (security fix)
  // ---------------------------------------------------------------------------
  //
  // These tests prove that `verifyVercelOidc()` (no args) only authenticates
  // tokens minted for the current Vercel project. The verifier fetches the
  // OIDC discovery document and JWKS to validate the JWT signature, so the
  // tests mock `globalThis.fetch` rather than rely on a live network. JWKS
  // caching inside jose is keyed on the discovery URL, so each test uses a
  // unique team slug (and therefore a unique issuer URL) to avoid bleeding
  // state across cases.

  it("authenticates a Vercel-issued token whose project_id matches VERCEL_PROJECT_ID", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("default-accept-current");
    try {
      const token = await issuer.signToken({
        environment: "production",
        owner: "acme",
        owner_id: "team_acme",
        project: "weather-agent",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:production",
      });

      const result = await verifyVercelOidc(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionAuth).toMatchObject({
          authenticator: "oidc",
          issuer: issuer.issuer,
          // Project + environment match → tagged as runtime caller.
          principalType: "runtime",
          subject: "owner:acme:project:weather-agent:environment:production",
        });
      }
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel-issued token whose project_id does not match VERCEL_PROJECT_ID", async () => {
    // Demonstrates the security fix: a token minted for an unrelated
    // Vercel project (with a fully valid signature, audience, and issuer
    // prefix) cannot authenticate against this deployment when no
    // `subjects` are configured.
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("default-reject-other-project");
    try {
      const token = await issuer.signToken({
        environment: "production",
        owner: "stranger",
        owner_id: "team_stranger",
        project: "stranger-agent",
        // Different project ID than the deployed eve app.
        project_id: "prj_other",
        sub: "owner:stranger:project:stranger-agent:environment:production",
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel-issued token that omits the project_id claim", async () => {
    // Defense in depth: a token without a `project_id` claim cannot
    // satisfy the always-on current-project bypass and there are no
    // author-supplied `subjects` to fall back on, so it must reject.
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("default-reject-missing-project");
    try {
      const token = await issuer.signToken({
        environment: "production",
        owner: "ghost",
        sub: "owner:ghost:project:ghost-agent:environment:production",
        // No `project_id` claim.
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("authenticates a Vercel external subject token as a user principal", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "preview");

    const issuer = await installMockedVercelIssuer("external-user-accept");
    try {
      const token = await issuer.signToken({
        connector_id: "connector_should_not_win",
        email: "ada@example.com",
        environment: "preview",
        external_iss: "https://github.com",
        external_sub: "github|ada",
        name: "Ada Lovelace",
        owner: "acme",
        picture: "https://example.com/ada.png",
        project: "weather-agent",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:preview",
      });

      const result = await verifyVercelOidc(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionAuth).toMatchObject({
          attributes: {
            connector_id: "connector_should_not_win",
            email: "ada@example.com",
            external_iss: "https://github.com",
            external_sub: "github|ada",
            name: "Ada Lovelace",
            picture: "https://example.com/ada.png",
          },
          authenticator: "oidc",
          issuer: "https://github.com",
          principalId: "https://github.com:github|ada",
          principalType: "user",
          subject: "github|ada",
        });
      }
    } finally {
      issuer.restore();
    }
  });

  it("falls back to connector_id as issuer for a Vercel external subject token", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("external-user-connector-issuer");
    try {
      const token = await issuer.signToken({
        connector_id: "connex:github",
        email: "ada@example.com",
        environment: "production",
        external_sub: "github|ada",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:production",
      });

      const result = await verifyVercelOidc(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionAuth).toMatchObject({
          authenticator: "oidc",
          issuer: "connex:github",
          principalId: "connex:github:github|ada",
          principalType: "user",
          subject: "github|ada",
        });
      }
    } finally {
      issuer.restore();
    }
  });

  it("falls back to the Vercel issuer for external subject tokens with no external issuer", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("external-user-vercel-issuer");
    try {
      const token = await issuer.signToken({
        email: "ada@example.com",
        environment: "production",
        external_sub: "github|ada",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:production",
      });

      const result = await verifyVercelOidc(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionAuth).toMatchObject({
          authenticator: "oidc",
          issuer: issuer.issuer,
          principalId: `${issuer.issuer}:github|ada`,
          principalType: "user",
          subject: "github|ada",
        });
      }
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel external subject token whose project_id does not match", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("external-user-reject-project");
    try {
      const token = await issuer.signToken({
        email: "ada@example.com",
        environment: "production",
        external_sub: "github|ada",
        project_id: "prj_other",
        sub: "owner:acme:project:weather-agent:environment:production",
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel external subject token whose environment does not match", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("external-user-reject-environment");
    try {
      const token = await issuer.signToken({
        email: "ada@example.com",
        environment: "preview",
        external_sub: "github|ada",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:preview",
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel external subject token when VERCEL_PROJECT_ID is unset", async () => {
    // Fail-closed: an external-subject ("user") token must not authenticate on
    // a deployment that has not pinned VERCEL_PROJECT_ID, even though the token
    // signature, issuer, and environment are otherwise valid. Before the fix
    // the unset project id was treated as "no constraint" and let any
    // Vercel-issued external-subject token through.
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "preview");

    const issuer = await installMockedVercelIssuer("external-user-reject-unset-project");
    try {
      const token = await issuer.signToken({
        email: "ada@example.com",
        environment: "preview",
        external_iss: "https://github.com",
        external_sub: "github|ada",
        owner: "acme",
        project: "weather-agent",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:preview",
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel external subject token when the deployment environment is unset", async () => {
    // Fail-closed: a "user" token must not authenticate when neither
    // VERCEL_TARGET_ENV nor VERCEL_ENV resolves a deployment environment, even
    // when the project id matches.
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");

    const issuer = await installMockedVercelIssuer("external-user-reject-unset-environment");
    try {
      const token = await issuer.signToken({
        email: "ada@example.com",
        environment: "production",
        external_iss: "https://github.com",
        external_sub: "github|ada",
        owner: "acme",
        project: "weather-agent",
        project_id: "prj_current",
        sub: "owner:acme:project:weather-agent:environment:production",
      });

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });

  it("rejects a Vercel-issued token whose audience is a foreign federation target", async () => {
    // Cross-audience replay: a token minted for the current project but for an
    // external federation audience (e.g. AWS STS) must not authenticate to the
    // agent, even though its signature, issuer, and project_id are valid. The
    // audience binding requires a Vercel (`https://vercel.com/...`) audience.
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_current");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");

    const issuer = await installMockedVercelIssuer("foreign-audience-reject");
    try {
      const token = await issuer.signToken(
        {
          environment: "production",
          owner: "acme",
          project: "weather-agent",
          project_id: "prj_current",
          sub: "owner:acme:project:weather-agent:environment:production",
        },
        { audience: "sts.amazonaws.com" },
      );

      await expect(verifyVercelOidc(token)).resolves.toEqual({ ok: false });
    } finally {
      issuer.restore();
    }
  });
});

/**
 * Installs a mocked Vercel OIDC issuer for unit-tier verifier tests.
 *
 * Generates a fresh RSA keypair, exports the public key as a JWK, and
 * installs a `globalThis.fetch` spy that responds to the issuer's
 * discovery and JWKS endpoints. Each call uses a unique team slug so
 * jose's module-level JWKS cache (keyed on the JWKS URL) does not bleed
 * keys across tests when several cases run in the same file.
 */
async function installMockedVercelIssuer(slug: string): Promise<{
  readonly issuer: string;
  readonly signToken: (
    claims: Record<string, unknown>,
    options?: { readonly audience?: string },
  ) => Promise<string>;
  readonly restore: () => void;
}> {
  const teamSlug = `${slug}-${crypto.randomUUID()}`;
  const issuer = `https://oidc.vercel.com/${teamSlug}`;
  const audience = `https://vercel.com/${teamSlug}`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const keyId = `test-key-${teamSlug}`;

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === discoveryUrl) {
      return new Response(JSON.stringify({ issuer, jwks_uri: jwksUrl }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    if (url === jwksUrl) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, use: "sig" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    return new Response("not found", { status: 404 });
  });

  return {
    issuer,
    restore() {
      fetchSpy.mockRestore();
    },
    async signToken(claims, options) {
      const { sub, ...rest } = claims;
      return await new SignJWT(rest)
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setAudience(options?.audience ?? audience)
        .setExpirationTime("5m")
        .setIssuedAt()
        .setIssuer(issuer)
        .setSubject(
          typeof sub === "string" ? sub : "owner:acme:project:test:environment:production",
        )
        .sign(privateKey);
    },
  };
}

describe("vercelSubject", () => {
  it("formats a strict project subject with explicit environment", () => {
    expect(
      vercelSubject({
        teamSlug: "acme",
        projectName: "weather-agent",
        environment: "production",
      }),
    ).toBe("owner:acme:project:weather-agent:environment:production");
  });

  it("defaults environment to production so omissions do not silently widen", () => {
    expect(vercelSubject({ teamSlug: "acme", projectName: "weather-agent" })).toBe(
      "owner:acme:project:weather-agent:environment:production",
    );
  });

  it("supports project names with underscores per the Vercel sub format", () => {
    // Vercel's documented `sub` format embeds the project NAME (e.g.
    // `acme_website`), not the stable `prj_…` ID. Underscores are
    // valid in project names and must round-trip through the helper.
    expect(vercelSubject({ teamSlug: "acme", projectName: "acme_website" })).toBe(
      "owner:acme:project:acme_website:environment:production",
    );
  });

  it("supports the explicit any-environment wildcard", () => {
    expect(
      vercelSubject({ teamSlug: "acme", projectName: "weather-agent", environment: "*" }),
    ).toBe("owner:acme:project:weather-agent:environment:*");
  });

  it("rejects wildcards in the team slug to prevent cross-team widening", () => {
    expect(() =>
      vercelSubject({
        teamSlug: "*",
        projectName: "weather-agent",
        environment: "production",
      }),
    ).toThrow(/teamSlug .* may not contain '\*'/);
  });

  it("rejects wildcards in the project name to prevent same-name collisions", () => {
    expect(() =>
      vercelSubject({
        teamSlug: "acme",
        projectName: "*",
        environment: "production",
      }),
    ).toThrow(/projectName .* may not contain '\*'/);
  });

  it("rejects colons in slugs because they are subject delimiters", () => {
    expect(() => vercelSubject({ teamSlug: "ac:me", projectName: "weather-agent" })).toThrow(
      /teamSlug .* may not contain ':'/,
    );
  });

  it("rejects empty slug segments", () => {
    expect(() => vercelSubject({ teamSlug: "", projectName: "weather-agent" })).toThrow(
      /teamSlug must be a non-empty string/,
    );
  });

  it("rejects unknown environment values", () => {
    expect(() =>
      vercelSubject({
        teamSlug: "acme",
        projectName: "weather-agent",
        environment: "staging" as never,
      }),
    ).toThrow(/invalid environment/);
  });
});

describe("vercelOidc strategy helper", () => {
  it("rejects requests with no Authorization header", async () => {
    const authFn = vercelOidc();
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
    });
    await expect(Promise.resolve(authFn(request))).resolves.toBeNull();
  });

  it("rejects malformed bearer payloads without throwing", async () => {
    const authFn = vercelOidc();
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
      headers: { authorization: "Bearer not.a.real.jwt" },
    });
    await expect(Promise.resolve(authFn(request))).resolves.toBeNull();
  });

  it("rejects bearer tokens whose issuer is not on the Vercel OIDC prefix", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setAudience("https://vercel.com/acme")
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer("https://attacker.example/oidc")
      .setSubject("acme")
      .sign(privateKey);

    const authFn = vercelOidc();
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(Promise.resolve(authFn(request))).resolves.toBeNull();
  });
});

describe("httpBasic strategy helper", () => {
  it("returns the verified principal on a matching credential", () => {
    const authFn = httpBasic({ password: "top-secret", username: "ops" });
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("ops:top-secret", "utf8").toString("base64")}`,
      },
    });
    const result = authFn(request);
    expect(result).toMatchObject({
      authenticator: "http-basic",
      principalId: "ops",
    });
  });

  it("rejects mismatched credentials", () => {
    const authFn = httpBasic({ password: "top-secret", username: "ops" });
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("ops:wrong", "utf8").toString("base64")}`,
      },
    });
    expect(authFn(request)).toBeNull();
  });
});

describe("jwtHmac strategy helper", () => {
  const secret = "shared-secret";

  it("returns the verified principal on a valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("weather-agent")
      .setExpirationTime("5m")
      .setIssuedAt()
      .setIssuer("https://internal.example")
      .setSubject("worker:cron")
      .sign(Buffer.from(secret, "utf8"));

    const authFn = jwtHmac({
      algorithm: "HS256",
      audiences: ["weather-agent"],
      issuer: "https://internal.example",
      secret,
      subjects: ["worker:*"],
    });
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await authFn(request);
    expect(result).toMatchObject({
      authenticator: "jwt-hmac",
      subject: "worker:cron",
    });
  });

  it("rejects requests with no Bearer header", async () => {
    const authFn = jwtHmac({
      algorithm: "HS256",
      audiences: ["weather-agent"],
      issuer: "https://internal.example",
      secret,
    });
    const request = new Request(TEST_ROUTE_URL, {
      method: "POST",
    });
    await expect(authFn(request)).resolves.toBeNull();
  });
});
