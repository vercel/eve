import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eveVercelOidc, type EveAuthFn, type EveVercelOidcOptions } from "#public/channels/eve.js";
import { httpBasic, routeAuth } from "#public/channels/auth.js";
import { installMockedVercelIssuer } from "#internal/testing/mock-vercel-oidc-issuer.js";

const ROUTE_URL = "https://agent.test/eve/v1/session";
const CURRENT_PROJECT = { projectId: "prj_agent", environment: "preview" };
const SUBJECT = "owner:acme:project:eval-runner:environment:preview";
const WILDCARD = "owner:acme:project:eval-runner:environment:*";

function request(token?: string): Request {
  return new Request(ROUTE_URL, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

type PermissionCase = {
  name: string;
  projectId: string;
  subjects?: EveVercelOidcOptions["subjects"];
  principalType: "runtime" | "service" | null;
  allowed: boolean;
};

describe("eveVercelOidc", () => {
  let issuer: Awaited<ReturnType<typeof installMockedVercelIssuer>>;

  beforeAll(async () => {
    issuer = await installMockedVercelIssuer("eve-channel-subject-grants");
  });

  afterAll(() => {
    issuer.restore();
  });

  beforeEach(() => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_unrelated_env");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "implicit current-project acceptance does not grant stubs",
      projectId: "prj_agent",
      principalType: "runtime",
      allowed: false,
    },
    {
      name: "an exact grant permits a runtime caller",
      projectId: "prj_agent",
      subjects: [{ subject: SUBJECT, allowToolStubs: true }],
      principalType: "runtime",
      allowed: true,
    },
    {
      name: "a wildcard grant authenticates and permits another project's service caller",
      projectId: "prj_runner",
      subjects: [{ subject: WILDCARD, allowToolStubs: true }],
      principalType: "service",
      allowed: true,
    },
    {
      name: "a matching false entry authenticates without granting stubs",
      projectId: "prj_runner",
      subjects: [{ subject: SUBJECT, allowToolStubs: false }],
      principalType: "service",
      allowed: false,
    },
    {
      name: "a plain subject string authenticates without granting stubs",
      projectId: "prj_runner",
      subjects: [SUBJECT],
      principalType: "service",
      allowed: false,
    },
    {
      name: "any matching true entry grants despite an earlier matching false entry",
      projectId: "prj_agent",
      subjects: [
        { subject: SUBJECT, allowToolStubs: false },
        { subject: WILDCARD, allowToolStubs: true },
      ],
      principalType: "runtime",
      allowed: true,
    },
    {
      name: "an unmatched true entry and a token-supplied grant do not grant current-project callers",
      projectId: "prj_agent",
      subjects: [{ subject: "owner:acme:project:other:environment:*", allowToolStubs: true }],
      principalType: "runtime",
      allowed: false,
    },
    {
      name: "an unmatched true entry cannot authenticate another project's caller",
      projectId: "prj_runner",
      subjects: [{ subject: "owner:acme:project:other:environment:*", allowToolStubs: true }],
      principalType: null,
      allowed: false,
    },
  ] satisfies PermissionCase[])(
    "$name",
    async ({ projectId, subjects, principalType, allowed }) => {
      const token = await issuer.signToken({
        allowToolStubs: true,
        environment: "preview",
        project_id: projectId,
        sub: SUBJECT,
      });
      const auth: EveAuthFn = eveVercelOidc({ currentVercelProject: CURRENT_PROJECT, subjects });

      const result = await auth(request(token));

      if (principalType === null) {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({ authenticator: "oidc", principalType, subject: SUBJECT });
        expect(result?.allowToolStubs === true).toBe(allowed);
      }
    },
  );

  it.each([
    {
      name: "external-subject users",
      environment: "preview",
      claims: { external_sub: "alice", external_iss: "https://accounts.example.test" },
      subject: "alice",
    },
    {
      name: "development user-id users",
      environment: "development",
      claims: { user_id: "user_alice" },
      subject: "user_alice",
    },
  ])(
    "does not grant stubs to $name even with a matching wildcard",
    async ({ environment, claims, subject }) => {
      const token = await issuer.signToken({
        ...claims,
        allowToolStubs: true,
        environment,
        project_id: CURRENT_PROJECT.projectId,
        sub: SUBJECT,
      });
      const auth = eveVercelOidc({
        currentVercelProject: { projectId: CURRENT_PROJECT.projectId, environment },
        subjects: [{ subject: "*", allowToolStubs: true }],
      });

      const result = await auth(request(token));

      expect(result).toMatchObject({ principalType: "user", subject });
      expect(result?.allowToolStubs === true).toBe(false);
    },
  );

  it("does not grant access from an otherwise eligible token with an invalid signature", async () => {
    const token = await issuer.signToken({
      environment: "preview",
      project_id: CURRENT_PROJECT.projectId,
      sub: SUBJECT,
    });
    const parts = token.split(".");
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    const auth = eveVercelOidc({
      currentVercelProject: CURRENT_PROJECT,
      subjects: [{ subject: SUBJECT, allowToolStubs: true }],
    });

    await expect(auth(request(parts.join(".")))).resolves.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not.a.real.jwt"],
  ] as const)("retains Bearer alongside Basic when the token is %s", async (_case, token) => {
    const result = await routeAuth(request(token), [
      httpBasic({ username: "ops", password: "secret" }, { realm: "evals" }),
      eveVercelOidc({ currentVercelProject: CURRENT_PROJECT }),
    ]);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toContain('Basic realm="evals"');
      expect(result.headers.get("www-authenticate")).toContain("Bearer");
    }
  });
});
