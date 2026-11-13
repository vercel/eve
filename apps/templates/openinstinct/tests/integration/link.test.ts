import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";
import type { ConnectionPrincipal } from "eve/connections";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Link wallet integration", () => {
  // Include PGlite startup and the full OAuth lifecycle on slower CI runners.
  it("connects an existing phone user, isolates callbacks, refreshes encrypted tokens, and revokes on disconnect", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("LINK_CLIENT_ID", "test-link-client");
    vi.stubEnv("LINK_CLIENT_SECRET", "test-link-secret");
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_link");
    const client = new PGlite();
    try {
      await client.exec(
        await readFile(
          new URL("../../db/migrations/0001_better-auth.sql", import.meta.url),
          "utf8"
        )
      );
      await client.exec(
        await readFile(
          new URL("../../db/migrations/0014_chief_tigra.sql", import.meta.url),
          "utf8"
        )
      );
      const database = drizzle(client, { schema });
      const Database = await import("@db");
      // SAFETY: PGlite implements the shared Drizzle query-builder and transaction API used by these services.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the database driver changes in this integration test.
      vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
      const { getAuth } = await import("@db/services/auth");
      const link = await import("@db/services/auth/link");
      const { GET, POST } = await import("@app/api/link/route");
      const { linkAuth } = await import("@agent/lib/link-auth");
      const auth = await getAuth();
      const signedIn = await auth.api.verifyPhoneNumber({
        body: { phoneNumber: "+12025550123", code: "123456" },
        returnHeaders: true,
      });
      const headers = new Headers({
        origin: "http://localhost:3000",
        cookie: signedIn.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      });
      const userId = signedIn.response.user.id;
      await expect(link.getLinkToken(userId)).rejects.toThrow(
        link.LinkConnectionRequiredError
      );

      const principal = {
        type: "user",
        id: `better-auth:${userId}`,
        issuer: "authjs",
        attributes: {
          workspaceId: accessScopeForUser(`better-auth:${userId}`).workspaceId,
        },
      } satisfies ConnectionPrincipal;
      const connection = { url: "" };
      const callbackUrl =
        "http://localhost:3000/eve/v1/connections/link/callback/eve-attempt/session:auth";
      await expect(
        linkAuth.getToken({ principal, connection })
      ).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
      await expect(
        linkAuth.getToken({ principal: { type: "app" }, connection })
      ).rejects.toMatchObject({ reason: "principal_required" });
      await expect(
        linkAuth.getToken({
          principal: {
            ...principal,
            attributes: { ...principal.attributes, scheduleId: "scheduled" },
          },
          connection,
        })
      ).rejects.toMatchObject({ reason: "principal_required" });
      const authorization = await linkAuth.startAuthorization({
        principal,
        connection,
        callbackUrl,
      });
      if (!authorization.resume)
        throw new Error("Expected a resumable Link authorization.");
      const pending = authorization.resume;
      expect(authorization.challenge.url).toBe(
        `http://localhost:3000/api/link?attempt=${pending.attempt}`
      );
      await expect(
        link.linkAuthorizationCallback("different-user", pending.attempt)
      ).rejects.toThrow("expired");
      await expect(
        link.startLinkAuthorization(userId, "https://attacker.example/callback")
      ).rejects.toThrow("Invalid");
      const expectedCallback = await link.linkAuthorizationCallback(
        userId,
        pending.attempt
      );
      const request = () =>
        new Request("http://localhost:3000/api/link", {
          method: "POST",
          headers,
          body: new URLSearchParams({
            operation: "connect",
            attempt: pending.attempt,
          }),
        });
      const denied = request();
      denied.headers.set("origin", "https://attacker.example");
      expect((await POST(denied)).status).toBe(403);
      const opaqueOrigin = request();
      opaqueOrigin.headers.set("origin", "null");
      expect((await POST(opaqueOrigin)).status).toBe(403);
      const missingOrigin = request();
      missingOrigin.headers.delete("origin");
      expect((await POST(missingOrigin)).status).toBe(403);

      const authorizationUrl = authorization.challenge.url;
      if (!authorizationUrl) throw new Error("Expected a Link connection URL.");
      expect(
        (await GET(new Request("http://localhost:3000/api/link"))).status
      ).toBe(400);
      expect(
        (await GET(new Request(`${authorizationUrl}invalid`))).status
      ).toBe(400);
      expect((await GET(new Request(authorizationUrl))).status).toBe(401);
      const otherSignedIn = await auth.api.verifyPhoneNumber({
        body: { phoneNumber: "+12025550124", code: "123456" },
        returnHeaders: true,
      });
      const otherHeaders = new Headers({
        cookie: otherSignedIn.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      });
      const otherUser = await GET(
        new Request(authorizationUrl, { headers: otherHeaders })
      );
      expect(new URL(otherUser.headers.get("location") ?? "").origin).toBe(
        "http://localhost:3000"
      );
      expect(otherUser.headers.getSetCookie()).toEqual([]);
      const navigationHeaders = new Headers(headers);
      navigationHeaders.delete("origin");
      const started = await GET(
        new Request(authorizationUrl, { headers: navigationHeaders })
      );
      expect(started.status).toBe(303);
      expect(started.headers.get("referrer-policy")).toBe("no-referrer");
      const destination = new URL(started.headers.get("location") ?? "");
      expect(destination.origin).toBe("https://login.link.com");
      expect(destination.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/api/auth/callback/link"
      );
      expect(destination.searchParams.get("code_challenge")).toBeTruthy();
      updateCookies(headers, started.headers);

      let linkSubject = "link-user";
      let refreshes = 0;
      const tokenRequests: URLSearchParams[] = [];
      const revokedTokens: (string | null)[] = [];
      let revokeSucceeds = false;
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const outgoing = new Request(input, init);
        const url = outgoing.url;
        const body = new URLSearchParams(await outgoing.text());
        if (url === "https://login.link.com/auth/token") {
          tokenRequests.push(body);
          if (body.get("grant_type") === "refresh_token") {
            refreshes++;

            return Response.json({
              access_token: "access-refreshed",
              refresh_token: "refresh-rotated",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "payment_methods.agentic userinfo:read",
            });
          }

          return Response.json({
            access_token: "access-original",
            refresh_token: "refresh-original",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "payment_methods.agentic userinfo:read",
          });
        }
        if (url === "https://api.link.com/userinfo")
          return Response.json({
            id: linkSubject,
            email: "wallet@example.com",
            email_verified: true,
            name: "Wallet owner",
          });
        if (url === "https://login.link.com/auth/revoke") {
          revokedTokens.push(body.get("token"));
          return new Response(null, { status: revokeSucceeds ? 200 : 503 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const callback = new URL("http://localhost:3000/api/auth/callback/link");
      callback.searchParams.set("code", "oauth-code");
      callback.searchParams.set(
        "state",
        destination.searchParams.get("state") ?? ""
      );
      const completed = await auth.handler(new Request(callback, { headers }));
      expect(completed.headers.get("location")).toBe(expectedCallback);
      const [saved] = await database.select().from(schema.account);
      expect(saved).toMatchObject({
        userId,
        issuer: "link",
        providerId: "link",
        accountId: "link-user",
      });
      expect(saved?.accessToken).not.toBe("access-original");
      expect(saved?.refreshToken).not.toBe("refresh-original");
      expect((await link.getLinkToken(userId)).token).toBe("access-original");
      await database
        .update(schema.account)
        .set({ accessTokenExpiresAt: new Date(0) })
        .where(eq(schema.account.userId, userId));
      expect((await link.getLinkToken(userId)).token).toBe("access-refreshed");
      expect(refreshes).toBe(1);
      expect(tokenRequests.map((body) => body.get("client_secret"))).toEqual([
        "test-link-secret",
        "test-link-secret",
      ]);
      expect(tokenRequests[0]?.get("code_verifier")).toBeTruthy();
      expect(tokenRequests[1]?.get("refresh_token")).toBe("refresh-original");
      await expect(link.getLinkToken("different-user")).rejects.toThrow(
        link.LinkConnectionRequiredError
      );
      expect(
        await link.consumeLinkAuthorization("different-user", pending.attempt)
      ).toBe(false);
      const completion = {
        principal,
        connection,
        callbackUrl,
        resume: pending,
        callback: { method: "GET", params: { attempt: pending.attempt } },
      };
      await expect(
        linkAuth.completeAuthorization({
          ...completion,
          callback: { method: "GET", params: { attempt: "wrong-attempt" } },
        })
      ).rejects.toMatchObject({ reason: "invalid_state" });
      expect((await linkAuth.completeAuthorization(completion)).token).toBe(
        "access-refreshed"
      );
      await expect(
        linkAuth.completeAuthorization(completion)
      ).rejects.toMatchObject({ reason: "invalid_state" });
      expect(await link.consumeLinkAuthorization(userId, pending.attempt)).toBe(
        false
      );
      const expired = await link.startLinkAuthorization(
        userId,
        expectedCallback
      );
      await database
        .update(schema.verification)
        .set({ expiresAt: new Date(0) });
      expect(await link.consumeLinkAuthorization(userId, expired.attempt)).toBe(
        false
      );
      const expiredRedirect = await GET(
        new Request(
          `http://localhost:3000/api/link?attempt=${expired.attempt}`,
          { headers }
        )
      );
      expect(
        new URL(expiredRedirect.headers.get("location") ?? "").searchParams.get(
          "error"
        )
      ).toBe("connection_failed");
      expect(expiredRedirect.headers.getSetCookie()).toEqual([]);

      // A different wallet cannot silently replace or coexist with this one.
      linkSubject = "different-link-user";
      const reconnect = await POST(
        new Request("http://localhost:3000/api/link", {
          method: "POST",
          headers,
          body: new URLSearchParams({ operation: "connect" }),
        })
      );
      const reconnectUrl = new URL(reconnect.headers.get("location") ?? "");
      updateCookies(headers, reconnect.headers);
      callback.searchParams.set(
        "state",
        reconnectUrl.searchParams.get("state") ?? ""
      );
      const rejected = await auth.handler(new Request(callback, { headers }));
      expect(
        new URL(rejected.headers.get("location") ?? "").searchParams.get(
          "error"
        )
      ).toBe("authorization_failed");
      expect(
        await database
          .select({ accountId: schema.account.accountId })
          .from(schema.account)
      ).toEqual([{ accountId: "link-user" }]);
      // The database also enforces this invariant if concurrent callbacks pass the precheck.
      await expect(
        database.insert(schema.account).values({
          id: "second-account",
          issuer: "link",
          accountId: "second-wallet",
          providerId: "link",
          userId,
          updatedAt: new Date(),
        })
      ).rejects.toMatchObject({ cause: { code: "23505" } });

      // A valid session older than the freshness window needs a new phone sign-in.
      await database
        .update(schema.session)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60_000) })
        .where(eq(schema.session.userId, userId));
      expect((await auth.api.getSession({ headers }))?.user.id).toBe(userId);
      const disconnectRequest = () =>
        new Request("http://localhost:3000/api/link", {
          method: "POST",
          headers,
          body: new URLSearchParams({ operation: "disconnect" }),
        });
      const staleDisconnect = await POST(disconnectRequest());
      expect(staleDisconnect.status).toBe(303);
      expect(
        new URL(staleDisconnect.headers.get("location") ?? "").searchParams.get(
          "error"
        )
      ).toBe("reauthentication_required");
      expect(revokedTokens).toEqual([]);
      expect(await link.getLinkAccount(userId)).toBeDefined();

      const reauthenticated = await auth.api.verifyPhoneNumber({
        body: { phoneNumber: "+12025550123", code: "123456" },
        headers,
        returnHeaders: true,
      });
      expect(reauthenticated.response.user.id).toBe(userId);
      expect(reauthenticated.response.token).not.toBe(signedIn.response.token);
      updateCookies(headers, reauthenticated.headers);
      const failedDisconnect = await POST(disconnectRequest());
      expect(failedDisconnect.status).toBe(303);
      expect(
        new URL(
          failedDisconnect.headers.get("location") ?? ""
        ).searchParams.get("error")
      ).toBe("disconnection_failed");
      expect(failedDisconnect.headers.get("cache-control")).toBe("no-store");
      expect(failedDisconnect.headers.get("referrer-policy")).toBe(
        "no-referrer"
      );
      expect(await link.getLinkAccount(userId)).toBeDefined();
      revokeSucceeds = true;
      const disconnected = await POST(disconnectRequest());
      expect(disconnected.status).toBe(303);
      expect(disconnected.headers.get("location")).toBe("/link");
      expect(await link.getLinkAccount(userId)).toBeUndefined();
      expect(revokedTokens).toEqual(["refresh-rotated", "refresh-rotated"]);
      expect((await auth.api.getSession({ headers }))?.user.id).toBe(userId);
    } finally {
      await client.close();
    }
  }, 15_000);
});

function updateCookies(headers: Headers, response: Headers) {
  const cookies = new Map(
    [
      ...(headers.get("cookie") ?? "").split("; "),
      ...response.getSetCookie().map((cookie) => cookie.split(";")[0] ?? ""),
    ]
      .filter(Boolean)
      .map((cookie) => [cookie.split("=")[0], cookie])
  );
  headers.set("cookie", [...cookies.values()].join("; "));
}
